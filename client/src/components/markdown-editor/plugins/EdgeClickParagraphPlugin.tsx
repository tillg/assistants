import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
    $createParagraphNode,
    $getRoot,
    $isDecoratorNode,
    $isElementNode,
    type LexicalEditor,
    type LexicalNode
} from "lexical";

import { $isAdmonitionNode } from "../nodes/AdmonitionNode";

/**
 * An edge block a click in the empty margin beside it can't put a caret past by native
 * placement, so such a click should start a fresh paragraph on the outer side of it:
 *  - a decorator (horizontal rule, TOC) or a shadow-root element (table) — no caret lands
 *    there at all (mirrors @lexical/extension's $defaultShouldInsertAfter);
 *  - an admonition panel — a container whose margin-click dives the caret into its body
 *    instead, leaving no way to reach a sibling outside the panel.
 */
function $isEdgeClickTrap(node: LexicalNode): boolean {
    return $isDecoratorNode(node) || $isAdmonitionNode(node) || ($isElementNode(node) && node.isShadowRoot());
}

/**
 * If the document ends in an edge click-trap block, append a paragraph after it and put the
 * caret there. Returns whether it did.
 */
export function $appendParagraphAfterTrappingLastBlock(): boolean {
    const lastChild = $getRoot().getLastChild();
    if (lastChild === null || !$isEdgeClickTrap(lastChild)) {
        return false;
    }
    const paragraph = $createParagraphNode();
    lastChild.insertAfter(paragraph);
    paragraph.select();
    return true;
}

/**
 * If the document starts with an edge click-trap block, insert a paragraph before it and put
 * the caret there. Returns whether it did.
 */
export function $prependParagraphBeforeTrappingFirstBlock(): boolean {
    const firstChild = $getRoot().getFirstChild();
    if (firstChild === null || !$isEdgeClickTrap(firstChild)) {
        return false;
    }
    const paragraph = $createParagraphNode();
    firstChild.insertBefore(paragraph);
    paragraph.select();
    return true;
}

/** Which document edge a margin-click should insert an escape paragraph at. */
type EdgeInsert = "before" | "after";

/**
 * The margin-click insertion this event calls for, or null if it isn't one: a click on the
 * root element in the empty margin below a trapping last block ("after") or above a trapping
 * first block ("before"). A block's own bottom/top pixel is exclusive — left to native
 * handling — so a click within a block's own box never claims. When a single trap block is
 * both first and last, the click's Y decides the side (below → after, above → before).
 */
function edgeInsertSide(editor: LexicalEditor, rootElement: HTMLElement, event: MouseEvent): EdgeInsert | null {
    if (!editor.isEditable() || event.target !== rootElement) {
        return null;
    }
    return editor.read(() => {
        const root = $getRoot();
        const lastChild = root.getLastChild();
        if (lastChild !== null && $isEdgeClickTrap(lastChild)) {
            const dom = editor.getElementByKey(lastChild.getKey());
            if (dom !== null && event.clientY > dom.getBoundingClientRect().bottom) {
                return "after";
            }
        }
        const firstChild = root.getFirstChild();
        if (firstChild !== null && $isEdgeClickTrap(firstChild)) {
            const dom = editor.getElementByKey(firstChild.getKey());
            if (dom !== null && event.clientY < dom.getBoundingClientRect().top) {
                return "before";
            }
        }
        return null;
    });
}

/**
 * Backport of @lexical/extension's ClickAfterLastBlockExtension (Lexical 0.46, issue #8544)
 * for the project's 0.31.2, generalized to both document edges and to panels. Clicking the
 * empty margin next to an edge block a caret can't be placed past — below the last block or
 * above the first block, when that block is a horizontal rule / TOC decorator or a table
 * (native leaves the selection null) or an admonition panel (native dives the caret into the
 * panel body) — inserts a paragraph on the outer side of that block and selects it, matching
 * the Lexical playground and Notion. (The top margin is the contenteditable's own padding.)
 *
 * Two capture-phase listeners on the root: mousedown preventDefault cancels the browser's
 * native caret pick before it paints (without it the caret lands on the edge block for one
 * frame — the flicker); the click handler then claims the event (flagging it
 * `_lexicalHandled`, the marker core's own root click handler skips on, so its default caret
 * placement never runs) and inserts the paragraph on the resolved side.
 *
 * REMOVAL: drop this for the native ClickAfterLastBlockExtension once the project is on a
 * Lexical with @lexical/extension (>= 0.44 ships it) — though upstream covers only the last
 * edge and only true caret traps, not panels.
 */
export function registerEdgeClickParagraph(editor: LexicalEditor): () => void {
    const onMouseDown = (event: MouseEvent) => {
        const root = editor.getRootElement();
        if (root !== null && edgeInsertSide(editor, root, event) !== null) {
            event.preventDefault();
        }
    };
    const onClick = (event: MouseEvent) => {
        const root = editor.getRootElement();
        if (root === null) {
            return;
        }
        const side = edgeInsertSide(editor, root, event);
        if (side === null) {
            return;
        }
        event.preventDefault();
        (event as MouseEvent & { _lexicalHandled?: boolean })._lexicalHandled = true;
        editor.update(() => {
            if (side === "after") {
                $appendParagraphAfterTrappingLastBlock();
            } else {
                $prependParagraphBeforeTrappingFirstBlock();
            }
        });
    };
    return editor.registerRootListener((rootElement, prevRootElement) => {
        if (prevRootElement !== null) {
            prevRootElement.removeEventListener("mousedown", onMouseDown, true);
            prevRootElement.removeEventListener("click", onClick, true);
        }
        if (rootElement !== null) {
            rootElement.addEventListener("mousedown", onMouseDown, true);
            rootElement.addEventListener("click", onClick, true);
        }
    });
}

export function EdgeClickParagraphPlugin(): null {
    const [editor] = useLexicalComposerContext();
    useEffect(() => registerEdgeClickParagraph(editor), [editor]);
    return null;
}
