import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createParagraphNode, $getSelection, $isRangeSelection, type LexicalEditor } from "lexical";

import { AdmonitionNode } from "../nodes/AdmonitionNode";

/**
 * Keep an admonition's body non-empty, re-adding an empty paragraph when its last
 * block is deleted. Mirrors the invariant the markdown importer already sets (an
 * empty-body `:::admonition` gets a placeholder paragraph).
 *
 * Without this, deleting the panel's only block leaves a childless AdmonitionNode
 * whose DOM still carries the non-editable title row. That title row shifts the
 * managed-children region (see AdmonitionNode.getDOMSlot), so resolving a click on
 * the empty container yields the element point `(panel, 1)` on a 0-child node —
 * which Lexical rejects (`$validatePoint: offset > getChildrenSize (1 > 0)`).
 */
export function $ensureAdmonitionNotEmpty(node: AdmonitionNode): void {
    if (!node.isEmpty()) {
        return;
    }
    const paragraph = $createParagraphNode();
    node.append(paragraph);
    // The delete that emptied the panel leaves the caret element-anchored on the
    // panel itself; move it into the fresh paragraph so typing resumes in the body.
    const selection = $getSelection();
    if ($isRangeSelection(selection) && selection.anchor.getNode().is(node)) {
        paragraph.selectStart();
    }
}

export function registerAdmonitionEmptyGuard(editor: LexicalEditor): () => void {
    return editor.registerNodeTransform(AdmonitionNode, $ensureAdmonitionNotEmpty);
}

export function AdmonitionEmptyGuardPlugin(): null {
    const [editor] = useLexicalComposerContext();
    useEffect(() => registerAdmonitionEmptyGuard(editor), [editor]);
    return null;
}
