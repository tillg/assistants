import { $createHorizontalRuleNode } from "@lexical/extension";
import {
    $createParagraphNode,
    $getRoot,
    $getSelection,
    $isElementNode,
    $isRangeSelection,
    $isRootOrShadowRoot,
    ParagraphNode,
    type BaseSelection,
    type ElementNode,
    type LexicalNode,
    type RangeSelection
} from "lexical";

import { $createAdmonitionNode, $isAdmonitionNode, type AdmonitionVariant } from "../nodes/AdmonitionNode";
import {
    $createTocNode,
    $isTocNode,
    TOC_MAX_LEVEL_DEFAULT,
    TOC_MIN_LEVEL_DEFAULT,
    type TocNode
} from "../nodes/TocNode";

/**
 * Block-insert operations shared by the toolbar and the insertion commands
 * ({@link InsertionCommandsPlugin}). Each is a plain `$`-prefixed function meant
 * to run inside an editor update — so they are directly unit-testable and reused
 * verbatim by every insertion surface (toolbar Insert menu, slash menu, shortcuts).
 */

/** The top-level element the (range) selection's anchor sits in, or null. */
export function $topLevelElement(selection: BaseSelection | null): ElementNode | null {
    if (!$isRangeSelection(selection)) {
        return null;
    }
    return selection.anchor.getNode().getTopLevelElement();
}

/**
 * The block element the selection anchor sits in, relative to its nearest block
 * *container* — the root or an admonition panel body. Like {@link $topLevelElement}
 * but treats a panel as a boundary, so a heading / list / quote *inside* a panel is
 * reported as that block rather than the panel: `getTopLevelElement()` would sail
 * past the panel to the panel node itself (its only root-level ancestor), which is
 * why block-type / list toolbar checks lost their active state inside a panel.
 *
 * Returns the highest block whose parent is the root/shadow-root or an admonition —
 * so a list resolves to its `ListNode` (not the `ListItemNode` a plain
 * nearest-ancestor walk would stop at). Panel detection and block insertion keep
 * using {@link $topLevelElement} (the true root-level block). A new nested block
 * container would need adding to the boundary test below.
 */
export function $currentBlock(selection: BaseSelection | null): ElementNode | null {
    if (!$isRangeSelection(selection)) {
        return null;
    }
    let node: LexicalNode = selection.anchor.getNode();
    for (let parent = node.getParent(); parent !== null; parent = node.getParent()) {
        if ($isRootOrShadowRoot(parent) || $isAdmonitionNode(parent)) {
            return $isElementNode(node) ? node : null;
        }
        node = parent;
    }
    return null;
}

function $ensureEmptyParagraph(focus: boolean): ParagraphNode | null {
    const root = $getRoot();
    const children = root.getChildren();
    if (children.length === 0) {
        const paragraph = $createParagraphNode();
        root.append(paragraph);
        if (focus) {
            paragraph.select();
        }
        return paragraph;
    }
    return null;
}

/**
 * The top-level block to insert a new block after, for the current range selection.
 * Normally that's the anchor's top-level element — but after removing an atom block
 * (TOC, image, horizontal rule) whose sibling is itself a decorator, or one that was
 * the document's first child, Lexical leaves the range-selection anchor on the
 * RootNode (`selectPrevious`/`moveSelectionPointToSibling` fall back to an element
 * point on the parent). The RootNode itself is not a top-level element, so resolve
 * the root child at the anchor offset instead (appending a paragraph if the document
 * is empty).
 */
function $blockToInsertAfter(selection: RangeSelection): LexicalNode {
    const topLevel = selection.anchor.getNode().getTopLevelElement();
    if (topLevel !== null) {
        return topLevel;
    }
    const children = $getRoot().getChildren();
    const paragraph = $ensureEmptyParagraph(false);
    if (paragraph) {
        return paragraph;
    }
    // Element point on the root at `offset` sits before child[offset]; insert after
    // the block just before the caret (clamped into range).
    const index = Math.min(Math.max(selection.anchor.offset - 1, 0), children.length - 1);
    return children[index]!;
}

/**
 * Guarantee a paragraph after `node` so a block that ends the document is not a caret trap.
 * Shared by every block-insert op (horizontal rule, TOC, panel). When `focus` is true,
 * also place the caret at the start of that following block — for atomic nodes (rule, TOC)
 * whose caret can't sit inside them; a panel passes `false` and keeps the caret in its body.
 */
export function $ensureBlockAfter(node: LexicalNode, focus: boolean): void {
    if (node.getNextSibling() === null) {
        node.insertAfter($createParagraphNode());
    }
    if (focus) {
        node.getNextSibling()?.selectStart();
    }
}

/** Insert a horizontal rule after the current block, landing the caret on the block that follows it. */
export function $insertHorizontalRule(): void {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) {
        return;
    }
    const topLevel = $blockToInsertAfter(selection);
    const rule = $createHorizontalRuleNode();
    topLevel.insertAfter(rule);
    // The rule is atomic — make sure a block follows it and land the caret there.
    $ensureBlockAfter(rule, true);
}

/** Distinct top-level blocks touched by `selection`, in document order (may include
 * block decorators such as a top-level image or horizontal rule). */
function $selectedTopLevelBlocks(selection: RangeSelection): LexicalNode[] {
    const blocks: LexicalNode[] = [];
    const seen = new Set<string>();
    for (const node of selection.getNodes()) {
        const top = node.getTopLevelElement();
        if (top !== null && !seen.has(top.getKey())) {
            seen.add(top.getKey());
            blocks.push(top);
        }
    }
    return blocks;
}

/**
 * Apply an admonition variant at the selection (runs in an editor update):
 * - caret already inside a panel → retype it in place, or unwrap it when the
 *   variant is unchanged (toggle off, mirroring the heading/quote/code buttons);
 * - a non-collapsed selection → enclose the selected block(s) in a new panel;
 * - a bare caret outside any panel → insert a fresh empty panel after the block.
 */
export function $applyAdmonitionVariant(variant: AdmonitionVariant): void {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) {
        return;
    }
    const anchorTop = selection.anchor.getNode().getTopLevelElement();
    if ($isAdmonitionNode(anchorTop)) {
        if (anchorTop.getAdmonitionType() === variant) {
            // Toggle off: lift the body blocks out, then drop the empty panel.
            for (const child of anchorTop.getChildren()) {
                anchorTop.insertBefore(child);
            }
            anchorTop.remove();
        } else {
            anchorTop.setAdmonitionType(variant);
        }
        return;
    }
    if (!selection.isCollapsed()) {
        const blocks = $selectedTopLevelBlocks(selection);
        if (blocks.length > 0) {
            const admonition = $createAdmonitionNode(variant);
            blocks[0]?.insertBefore(admonition);
            for (const block of blocks) {
                admonition.append(block);
            }
            // Caret stays in the panel body, so don't focus the trailing escape paragraph.
            $ensureBlockAfter(admonition, false);
            admonition.selectEnd();
            return;
        }
    }
    const top = $blockToInsertAfter(selection);
    const admonition = $createAdmonitionNode(variant);
    const body = $createParagraphNode();
    admonition.append(body);
    top.insertAfter(admonition);
    $ensureBlockAfter(admonition, false);
    body.select();
}

/**
 * The TOC the selection sits on, if any. The TOC is an atom decorator that can't
 * hold a caret, so "on a TOC" means it is node-selected (a click selects the node,
 * see TocNode) or a range spans it — both surface through getNodes().
 */
export function $tocNodeAtSelection(selection: BaseSelection | null): TocNode | null {
    for (const node of selection?.getNodes() ?? []) {
        if ($isTocNode(node)) {
            return node;
        }
    }
    return null;
}

/**
 * Toggle the table of contents (runs in an editor update): when the selection is
 * on an existing TOC, remove it (mirroring the quote/code/panel toggle buttons);
 * otherwise insert a fresh TOC after the current block.
 */
export function $toggleTableOfContents(): void {
    const selection = $getSelection();
    const existing = $tocNodeAtSelection(selection);
    if (existing !== null) {
        // Remove and stop — otherwise a range that spans the TOC would re-insert one.
        existing.remove();
        $ensureEmptyParagraph(true);
        return;
    }
    if (!$isRangeSelection(selection)) {
        return;
    }
    const topLevel = $blockToInsertAfter(selection);
    const toc = $createTocNode(TOC_MIN_LEVEL_DEFAULT, TOC_MAX_LEVEL_DEFAULT);
    topLevel.insertAfter(toc);
    // The TOC is an atom decorator — make sure a block follows it and land the caret there.
    $ensureBlockAfter(toc, true);
}
