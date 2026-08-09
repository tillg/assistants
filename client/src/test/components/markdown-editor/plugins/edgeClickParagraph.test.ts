import { $createHorizontalRuleNode } from "@lexical/extension";
import { $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isRangeSelection } from "lexical";
import { describe, expect, it } from "vitest";

import { $createAdmonitionNode } from "../../../../components/markdown-editor/nodes/AdmonitionNode";
import {
    $appendParagraphAfterTrappingLastBlock,
    $prependParagraphBeforeTrappingFirstBlock
} from "../../../../components/markdown-editor/plugins/EdgeClickParagraphPlugin";

import { createTestEditor } from "../markdownTestUtils";

function rootTypes(editor: ReturnType<typeof createTestEditor>): string[] {
    let types: string[] = [];
    editor.getEditorState().read(() => {
        types = $getRoot()
            .getChildren()
            .map((node) => node.getType());
    });
    return types;
}

/** Whether the caret sits in the top-level block at `index` (from document start). */
function caretInBlock(editor: ReturnType<typeof createTestEditor>, index: number): boolean {
    let inBlock = false;
    editor.getEditorState().read(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
            inBlock = selection.anchor.getNode().getTopLevelElement() === $getRoot().getChildAtIndex(index);
        }
    });
    return inBlock;
}

describe("$appendParagraphAfterTrappingLastBlock", () => {
    it("appends a paragraph after a terminal horizontal rule and lands the caret in it", () => {
        const editor = createTestEditor();
        let inserted = false;
        editor.update(
            () => {
                const root = $getRoot();
                root.clear();
                root.append($createParagraphNode().append($createTextNode("text")));
                root.append($createHorizontalRuleNode());
                inserted = $appendParagraphAfterTrappingLastBlock();
            },
            { discrete: true }
        );

        expect(inserted).toBe(true);
        expect(rootTypes(editor)).toEqual(["paragraph", "horizontalrule", "paragraph"]);
        expect(caretInBlock(editor, 2)).toBe(true);
    });

    it("appends a paragraph after a terminal panel and lands the caret in it", () => {
        const editor = createTestEditor();
        let inserted = false;
        editor.update(
            () => {
                const root = $getRoot();
                root.clear();
                const admonition = $createAdmonitionNode("info");
                admonition.append($createParagraphNode().append($createTextNode("body")));
                root.append(admonition);
                inserted = $appendParagraphAfterTrappingLastBlock();
            },
            { discrete: true }
        );

        expect(inserted).toBe(true);
        expect(rootTypes(editor)).toEqual(["admonition", "paragraph"]);
        expect(caretInBlock(editor, 1)).toBe(true);
    });

    it("does nothing when the document already ends in a paragraph", () => {
        const editor = createTestEditor();
        let inserted = true;
        editor.update(
            () => {
                const root = $getRoot();
                root.clear();
                root.append($createHorizontalRuleNode());
                root.append($createParagraphNode().append($createTextNode("after")));
                inserted = $appendParagraphAfterTrappingLastBlock();
            },
            { discrete: true }
        );

        expect(inserted).toBe(false);
        expect(rootTypes(editor)).toEqual(["horizontalrule", "paragraph"]);
    });
});

describe("$prependParagraphBeforeTrappingFirstBlock", () => {
    it("inserts a paragraph before a leading panel and lands the caret in it", () => {
        const editor = createTestEditor();
        let inserted = false;
        editor.update(
            () => {
                const root = $getRoot();
                root.clear();
                const admonition = $createAdmonitionNode("info");
                admonition.append($createParagraphNode().append($createTextNode("body")));
                root.append(admonition);
                inserted = $prependParagraphBeforeTrappingFirstBlock();
            },
            { discrete: true }
        );

        expect(inserted).toBe(true);
        expect(rootTypes(editor)).toEqual(["paragraph", "admonition"]);
        expect(caretInBlock(editor, 0)).toBe(true);
    });

    it("inserts a paragraph before a leading horizontal rule", () => {
        const editor = createTestEditor();
        let inserted = false;
        editor.update(
            () => {
                const root = $getRoot();
                root.clear();
                root.append($createHorizontalRuleNode());
                root.append($createParagraphNode().append($createTextNode("text")));
                inserted = $prependParagraphBeforeTrappingFirstBlock();
            },
            { discrete: true }
        );

        expect(inserted).toBe(true);
        expect(rootTypes(editor)).toEqual(["paragraph", "horizontalrule", "paragraph"]);
        expect(caretInBlock(editor, 0)).toBe(true);
    });

    it("does nothing when the document already starts with a paragraph", () => {
        const editor = createTestEditor();
        let inserted = true;
        editor.update(
            () => {
                const root = $getRoot();
                root.clear();
                root.append($createParagraphNode().append($createTextNode("before")));
                root.append($createHorizontalRuleNode());
                inserted = $prependParagraphBeforeTrappingFirstBlock();
            },
            { discrete: true }
        );

        expect(inserted).toBe(false);
        expect(rootTypes(editor)).toEqual(["paragraph", "horizontalrule"]);
    });
});
