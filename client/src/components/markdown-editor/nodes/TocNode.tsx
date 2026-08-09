import { $isHeadingNode } from "@lexical/rich-text";
import {
    $createNodeSelection,
    $getNodeByKey,
    $getRoot,
    $isElementNode,
    $setSelection,
    CLICK_COMMAND,
    COMMAND_PRIORITY_LOW,
    DecoratorNode,
    type DOMConversionMap,
    type LexicalEditor,
    type LexicalNode,
    type NodeKey,
    type SerializedLexicalNode,
    type Spread
} from "lexical";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import styled from "styled-components";

import {
    AttachedPortal,
    BufferedInput,
    Button,
    HTMLInputAdapter,
    Icon,
    Link,
    Message,
    TextField
} from "@com.mgmtp.a12.widgets/widgets-core";

import { RESOURCE_KEYS, useLocalizer } from "../../../localization";

import { buildTocTree, slugify, type HeadingItem, type TocTreeNode } from "./tocTree";

const TOC_KEYS = RESOURCE_KEYS.markdownEditor.toc;

/*
 * Presentation for the TOC view. This is our own React tree (DecoratorNode body),
 * so its styling is co-located here rather than in the editor's global theme —
 * `theme.colors.*` is typed by widgets-core's augmented styled-components theme.
 */
const TocContainer = styled.div`
    position: relative;
    margin: 12px 0;
    /* Extra right padding + min-height reserve room for the absolutely-positioned
     * gear control (see TocControls) so it never overlaps a long heading nor pokes
     * out of a short/empty card. */
    padding: 8px 44px 8px 12px;
    min-height: 50px;
    box-sizing: border-box;
    border: 1px solid ${({ theme }) => theme.colors.divider.color};
    border-radius: 4px;
    background: ${({ theme }) => theme.colors.background.nonInteractiveBackground};

    /* Outermost list sits flush; nested lists keep their indent. */
    nav > ol {
        padding-left: 0;
    }
`;

/* Hierarchical section numbers (1, 1.1, 2) come from CSS counters walking the
 * nesting; each list level resets the counter and each item increments it. */
const TocOrderedList = styled.ol`
    counter-reset: md-toc-section;
    list-style: none;
    margin: 0;
    padding-left: 18px;

    li {
        counter-increment: md-toc-section;
    }

    li > a::before {
        content: counters(md-toc-section, ".") "  ";
        font-variant-numeric: tabular-nums;
    }
`;

const TocControls = styled.span`
    position: absolute;
    top: 4px;
    right: 4px;
`;

/* Chrome only — positioning/overlay behaviour is handled by the A12
 * AttachedPortal that hosts this content (see TocLevelEditor). */
const TocPopover = styled.div`
    box-sizing: border-box;
    width: 220px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border: 1px solid ${({ theme }) => theme.colors.divider.color};
    border-radius: 4px;
    background: ${({ theme }) => theme.colors.background.primaryBackground};
    box-shadow: 0 2px 8px ${({ theme }) => theme.colors.boxShadowBackground};
`;

/**
 * Buffered single-line text input: A12's standard text field (BufferedInput HOC +
 * HTMLInputAdapter). It buffers keystrokes locally and fires `onValueSubmit` on
 * blur / Enter — so the TOC level inputs need no manual change/commit wiring.
 */
const BufferedTextLine = BufferedInput(HTMLInputAdapter(TextField));

export const TOC_MIN_LEVEL_DEFAULT = 1;
export const TOC_MAX_LEVEL_DEFAULT = 6;

/** Coerce a raw level to an integer in 1..6 (no swap on degenerate ranges). */
export function clampTocLevel(raw: unknown, fallback: number): number {
    const n = typeof raw === "string" ? Number.parseInt(raw, 10) : Number(raw);
    if (!Number.isFinite(n)) {
        return fallback;
    }
    if (n < 1) {
        return 1;
    }
    if (n > 6) {
        return 6;
    }
    return Math.trunc(n);
}

export type SerializedTocNode = Spread<{ minLevel: number; maxLevel: number }, SerializedLexicalNode>;

/**
 * Table-of-contents block — a `:::toc{minLevel="1" maxLevel="6"}` leaf directive
 * (spec 009). Extends `DecoratorNode`: it has no editable body; the rendered
 * nested list is a VIEW projected from the live heading tree at render time, not
 * persisted bytes (the directive body is always empty, so cycle-2 byte-identity
 * holds). `minLevel`/`maxLevel` are clamped to 1..6.
 */
export class TocNode extends DecoratorNode<ReactElement> {
    __minLevel: number;
    __maxLevel: number;

    static override getType(): string {
        return "toc";
    }

    static override clone(node: TocNode): TocNode {
        return new TocNode(node.__minLevel, node.__maxLevel, node.__key);
    }

    static override importJSON(serializedNode: SerializedTocNode): TocNode {
        return $createTocNode(serializedNode.minLevel, serializedNode.maxLevel);
    }

    constructor(minLevel: number, maxLevel: number, key?: NodeKey) {
        super(key);
        this.__minLevel = clampTocLevel(minLevel, TOC_MIN_LEVEL_DEFAULT);
        this.__maxLevel = clampTocLevel(maxLevel, TOC_MAX_LEVEL_DEFAULT);
    }

    override exportJSON(): SerializedTocNode {
        return {
            ...super.exportJSON(),
            minLevel: this.__minLevel,
            maxLevel: this.__maxLevel
        };
    }

    getMinLevel(): number {
        return this.getLatest().__minLevel;
    }

    getMaxLevel(): number {
        return this.getLatest().__maxLevel;
    }

    setLevels(minLevel: number, maxLevel: number): void {
        const writable = this.getWritable();
        writable.__minLevel = clampTocLevel(minLevel, TOC_MIN_LEVEL_DEFAULT);
        writable.__maxLevel = clampTocLevel(maxLevel, TOC_MAX_LEVEL_DEFAULT);
    }

    override createDOM(): HTMLElement {
        // Bare decorator host; the visible card is the styled TocContainer below.
        return document.createElement("div");
    }

    override updateDOM(): false {
        return false;
    }

    // Block-level (full-width card), not an inline atom — matches its placement as
    // a top-level sibling and gives it normal block selection/caret behaviour.
    override isInline(): boolean {
        return false;
    }

    static override importDOM(): DOMConversionMap | null {
        return null;
    }

    override decorate(editor: LexicalEditor): ReactElement {
        return (
            <TocView editor={editor} nodeKey={this.getKey()} minLevel={this.__minLevel} maxLevel={this.__maxLevel} />
        );
    }
}

export function $createTocNode(minLevel: number, maxLevel: number): TocNode {
    return new TocNode(minLevel, maxLevel);
}

export function $isTocNode(node: LexicalNode | null | undefined): node is TocNode {
    return node instanceof TocNode;
}

/** Collect headings (whole tree, document order) whose level is in [min, max].
 * Must run inside an editor read/update context (the `$` prefix marks that). */
function $collectHeadings(minLevel: number, maxLevel: number): HeadingItem[] {
    const items: HeadingItem[] = [];
    const visit = (node: LexicalNode): void => {
        if (!$isElementNode(node)) {
            return;
        }
        for (const child of node.getChildren()) {
            if ($isHeadingNode(child)) {
                const level = Number(child.getTag().slice(1));
                if (level >= minLevel && level <= maxLevel) {
                    const text = child.getTextContent();
                    items.push({ level, text, slug: slugify(text), nodeKey: child.getKey() });
                }
            } else if ($isElementNode(child)) {
                visit(child);
            }
        }
    };
    visit($getRoot());
    return items;
}

type AnchorClickHandler = (event: React.MouseEvent<HTMLAnchorElement>, nodeKey: string) => void;

/** Render the heading tree as nested `<ol>`; section numbers come from CSS counters. */
function TocList({ nodes, onItemClick }: { nodes: readonly TocTreeNode[]; onItemClick: AnchorClickHandler }) {
    if (nodes.length === 0) {
        return null;
    }
    return (
        <TocOrderedList>
            {nodes.map((node) => (
                <li key={node.key}>
                    <Link href={`#${node.slug}`} useAsButton onClick={(event) => onItemClick(event, node.nodeKey)}>
                        {node.text}
                    </Link>
                    <TocList nodes={node.children} onItemClick={onItemClick} />
                </li>
            ))}
        </TocOrderedList>
    );
}

interface TocViewProps {
    editor: LexicalEditor;
    nodeKey: NodeKey;
    minLevel: number;
    maxLevel: number;
}

/**
 * Live TOC projection. Recomputes the heading list on every editor update but
 * only re-renders when the projected list actually changes (signature compare),
 * keeping it cheap. Anchor clicks scroll to the heading via its Lexical node key
 * (robust to in-session edits); the `#slug` href is shown for w12-free parity.
 */
function TocView({ editor, nodeKey, minLevel, maxLevel }: TocViewProps) {
    const localizer = useLocalizer();
    const [headings, setHeadings] = useState<HeadingItem[]>(() =>
        editor.getEditorState().read(() => $collectHeadings(minLevel, maxLevel))
    );
    const signatureRef = useRef("");
    const editable = editor.isEditable();

    useEffect(() => {
        const recompute = () => {
            editor.getEditorState().read(() => {
                const items = $collectHeadings(minLevel, maxLevel);
                const signature = items.map((item) => `${item.level}:${item.nodeKey}:${item.text}`).join("|");
                if (signature !== signatureRef.current) {
                    signatureRef.current = signature;
                    setHeadings(items);
                }
            });
        };
        recompute();
        return editor.registerUpdateListener(recompute);
    }, [editor, minLevel, maxLevel]);

    // Clicking the TOC chrome (not a heading link, the gear, or the popover)
    // selects the whole atom node, so the toolbar's TOC button can toggle it off
    // and arrow keys step past it. Interactive descendants keep their behaviour.
    useEffect(() => {
        return editor.registerCommand(
            CLICK_COMMAND,
            (event: MouseEvent) => {
                const host = editor.getElementByKey(nodeKey);
                const target = event.target;
                if (host === null || !(target instanceof Node) || !host.contains(target)) {
                    return false;
                }
                if (target instanceof Element && target.closest("a, button, input") !== null) {
                    return false;
                }
                const selection = $createNodeSelection();
                selection.add(nodeKey);
                $setSelection(selection);
                return true;
            },
            COMMAND_PRIORITY_LOW
        );
    }, [editor, nodeKey]);

    const tree = useMemo(() => buildTocTree(headings), [headings]);

    const onItemClick: AnchorClickHandler = (event, key) => {
        event.preventDefault();
        editor.getElementByKey(key)?.scrollIntoView({ behavior: "smooth", block: "start" });
    };

    // contentEditable=false: the projection is generated, not typed into — this
    // stops the caret landing in it (a caret can't sit on an atom decorator) so a
    // click cleanly selects the node instead.
    return (
        <TocContainer contentEditable={false} data-min-level={minLevel} data-max-level={maxLevel}>
            {editable && <TocLevelEditor editor={editor} nodeKey={nodeKey} minLevel={minLevel} maxLevel={maxLevel} />}
            <nav aria-label={localizer(TOC_KEYS.ariaLabel)}>
                {tree.length === 0 ? (
                    <Message>{localizer(TOC_KEYS.empty)}</Message>
                ) : (
                    <TocList nodes={tree} onItemClick={onItemClick} />
                )}
            </nav>
        </TocContainer>
    );
}

/** Popover (a gear toggle + two level inputs) for editing min/max level. The popover is
 * an A12 {@link AttachedPortal} — it positions itself relative to the gear, renders at
 * document level (so it is not clipped by the editor), and handles outside-click / Esc. */
function TocLevelEditor({ editor, nodeKey, minLevel, maxLevel }: TocViewProps) {
    const localizer = useLocalizer();
    const [open, setOpen] = useState(false);
    const [trigger, setTrigger] = useState<HTMLElement | null>(null);

    // Commit one level; the sibling level is read live off the node so two edits
    // before close don't clobber each other.
    const submitMinLevel = (value?: string) => {
        editor.update(() => {
            const node = $getNodeByKey(nodeKey);
            if ($isTocNode(node)) {
                node.setLevels(clampTocLevel(value, TOC_MIN_LEVEL_DEFAULT), node.getMaxLevel());
            }
        });
    };
    const submitMaxLevel = (value?: string) => {
        editor.update(() => {
            const node = $getNodeByKey(nodeKey);
            if ($isTocNode(node)) {
                node.setLevels(node.getMinLevel(), clampTocLevel(value, TOC_MAX_LEVEL_DEFAULT));
            }
        });
    };

    return (
        <TocControls ref={setTrigger}>
            <Button
                secondary
                icon={<Icon iconTheme="outlined">settings</Icon>}
                title={localizer(TOC_KEYS.settingsTitle)}
                onClick={() => setOpen((value) => !value)}
            />
            {open && trigger && (
                <AttachedPortal
                    referenceElement={trigger}
                    orientation="bottom-end"
                    closeOnEsc
                    closeOnClickReferenceElement={false}
                    closeOnOutsideClick={{ exception: [trigger] }}
                    onVisibilityChange={(visible) => {
                        if (!visible) {
                            setOpen(false);
                        }
                    }}>
                    <TocPopover>
                        <BufferedTextLine
                            label={localizer(TOC_KEYS.minLevel)}
                            initialValue={String(minLevel)}
                            submitOnEnter
                            onValueSubmit={submitMinLevel}
                        />
                        <BufferedTextLine
                            label={localizer(TOC_KEYS.maxLevel)}
                            initialValue={String(maxLevel)}
                            submitOnEnter
                            onValueSubmit={submitMaxLevel}
                        />
                    </TocPopover>
                </AttachedPortal>
            )}
        </TocControls>
    );
}
