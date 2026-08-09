import { useEffect } from "react";
import { $createCodeNode } from "@lexical/code";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createHorizontalRuleNode } from "@lexical/extension";
import {
    $createParagraphNode,
    $getSelection,
    $isParagraphNode,
    $isRangeSelection,
    $isTextNode,
    COMMAND_PRIORITY_LOW,
    KEY_ENTER_COMMAND,
    type ElementNode,
    type LexicalEditor
} from "lexical";

/** Whole-line block syntaxes that have no trailing-space trigger — mirror markdownTransformers.ts. */
const HR_LINE = /^(---|\*\*\*|___)$/;
const CODE_FENCE_LINE = /^```(\w+)?$/;

/** The paragraph the caret sits at the *end* of, or null — the precondition both conversions share. */
function $caretEndParagraph(): ElementNode | null {
    const selection = $getSelection();
    if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
        return null;
    }
    const anchorNode = selection.anchor.getNode();
    if (!$isTextNode(anchorNode) || selection.anchor.offset !== anchorNode.getTextContentSize()) {
        return null;
    }
    const block = anchorNode.getTopLevelElement();
    return $isParagraphNode(block) ? block : null;
}

/** `---` / `***` / `___` → horizontal rule + trailing empty paragraph for the caret. */
export function $convertHorizontalRuleLine(): boolean {
    const block = $caretEndParagraph();
    if (!block || !HR_LINE.test(block.getTextContent())) {
        return false;
    }
    const rule = $createHorizontalRuleNode();
    const trailing = $createParagraphNode();
    // Move the caret onto a node that survives the replacement *before* removing
    // the old paragraph — Lexical errors if the selected node is removed without
    // the selection being moved off it first.
    block.insertAfter(trailing);
    trailing.selectStart();
    block.replace(rule);
    return true;
}

/** ` ``` ` / ` ```lang ` → empty code block (with the language, if given), caret inside it. */
export function $convertCodeFenceLine(): boolean {
    const block = $caretEndParagraph();
    if (!block) {
        return false;
    }
    const match = CODE_FENCE_LINE.exec(block.getTextContent());
    if (!match) {
        return false;
    }
    // match[1] is the captured language or undefined (the `(\w+)?` group is never "").
    const code = $createCodeNode(match[1]);
    block.replace(code);
    code.selectStart();
    return true;
}

/**
 * Backport of Lexical's "run markdown shortcuts on Enter" for the block
 * syntaxes that have no trailing-space trigger and so never fire under stock
 * 0.31.2's space-gated MarkdownShortcuts: the horizontal rule (`---`) and the
 * code fence (` ``` `). Without this, a bare `---`/` ``` ` + Enter stays text;
 * you'd have to type a trailing space.
 *
 * REMOVAL — these become native at different Lexical versions:
 *   - code fence: 0.41.0 (multiline-transformer Enter, facebook/lexical#8140) —
 *     already native in A12 2026.06's 0.44.0, so drop `$convertCodeFenceLine`
 *     once the project is on >= 0.41.0;
 *   - horizontal rule: 0.45.0 (element-transformer Enter, #8488) — drop the
 *     whole plugin (and its mount in MarkdownRichTextEditor) once on >= 0.45.0.
 */
export function registerBlockMarkdownEnter(editor: LexicalEditor): () => void {
    return editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event) => {
            if (!editor.isEditable()) {
                return false;
            }
            if (!$convertCodeFenceLine() && !$convertHorizontalRuleLine()) {
                return false;
            }
            event?.preventDefault();
            return true;
        },
        COMMAND_PRIORITY_LOW
    );
}

export function BlockMarkdownEnterPlugin(): null {
    const [editor] = useLexicalComposerContext();
    useEffect(() => registerBlockMarkdownEnter(editor), [editor]);
    return null;
}
