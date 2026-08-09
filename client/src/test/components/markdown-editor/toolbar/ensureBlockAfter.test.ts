import { $createHorizontalRuleNode } from "@lexical/extension";
import { $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isRangeSelection } from "lexical";
import { describe, expect, it } from "vitest";

import { $ensureBlockAfter } from "../../../../components/markdown-editor/insertion/blockInsertion";

import { createTestEditor } from "../markdownTestUtils";

/** Build a root of paragraphs (text per entry), returning the editor. */
function seed(texts: string[]) {
    const editor = createTestEditor();
    editor.update(
        () => {
            const root = $getRoot();
            root.clear();
            for (const text of texts) {
                const paragraph = $createParagraphNode();
                paragraph.append($createTextNode(text));
                root.append(paragraph);
            }
        },
        { discrete: true }
    );
    return editor;
}

/** Top-level block types at root. */
function rootTypes(editor: ReturnType<typeof createTestEditor>): string[] {
    let types: string[] = [];
    editor.getEditorState().read(() => {
        types = $getRoot()
            .getChildren()
            .map((node) => node.getType());
    });
    return types;
}

describe("$ensureBlockAfter", () => {
    it("adds a trailing paragraph when the node ends the document", () => {
        const editor = seed(["only"]);
        editor.update(
            () => {
                const rule = $createHorizontalRuleNode();
                $getRoot().getLastChildOrThrow().insertAfter(rule);
                $ensureBlockAfter(rule, false);
            },
            { discrete: true }
        );
        expect(rootTypes(editor)).toEqual(["paragraph", "horizontalrule", "paragraph"]);
    });

    it("does not add a paragraph when a block already follows", () => {
        const editor = seed(["first", "second"]);
        editor.update(
            () => {
                const rule = $createHorizontalRuleNode();
                $getRoot().getFirstChildOrThrow().insertAfter(rule);
                $ensureBlockAfter(rule, false);
            },
            { discrete: true }
        );
        // No stray paragraph injected between the rule and the existing "second".
        expect(rootTypes(editor)).toEqual(["paragraph", "horizontalrule", "paragraph"]);
    });

    it("places the caret in the following block when focus is true", () => {
        const editor = seed(["intro"]);
        editor.update(
            () => {
                const rule = $createHorizontalRuleNode();
                $getRoot().getLastChildOrThrow().insertAfter(rule);
                $ensureBlockAfter(rule, true);
            },
            { discrete: true }
        );

        let caretInTrailingParagraph = false;
        editor.getEditorState().read(() => {
            const selection = $getSelection();
            if ($isRangeSelection(selection)) {
                caretInTrailingParagraph =
                    selection.anchor.getNode().getTopLevelElement() === $getRoot().getLastChild();
            }
        });
        expect(caretInTrailingParagraph).toBe(true);
    });
});
