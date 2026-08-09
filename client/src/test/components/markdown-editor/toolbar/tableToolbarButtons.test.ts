import { $createTableNodeWithDimensions } from "@lexical/table";
import { $createParagraphNode, $getRoot, $getSelection, type LexicalEditor } from "lexical";
import { describe, expect, it } from "vitest";

import {
    $isSelectionInTable,
    tableOpsToolbarButtons
} from "../../../../components/markdown-editor/toolbar/tableToolbarButtons";

import { createTestEditor } from "../markdownTestUtils";

/** Identity localizer — the table ops test only checks count and disabled state, not labels. */
const localize = (key: string) => key;
const TABLE_OPS_TOOLBAR_BUTTONS = tableOpsToolbarButtons(localize);

function createEditorWithTableSelection(): LexicalEditor {
    const editor = createTestEditor();
    editor.update(
        () => {
            const table = $createTableNodeWithDimensions(2, 2, { rows: true, columns: false });
            $getRoot().append(table);
            table.selectEnd();
        },
        { discrete: true }
    );
    return editor;
}

function createEditorWithParagraphSelection(): LexicalEditor {
    const editor = createTestEditor();
    editor.update(
        () => {
            const p = $createParagraphNode();
            $getRoot().append(p);
            p.select();
        },
        { discrete: true }
    );
    return editor;
}

describe("$isSelectionInTable", () => {
    it("is true when the selection is inside a table cell", () => {
        const editor = createEditorWithTableSelection();
        editor.getEditorState().read(() => {
            expect($isSelectionInTable($getSelection())).toBe(true);
        });
    });

    it("is false outside a table", () => {
        const editor = createEditorWithParagraphSelection();
        editor.getEditorState().read(() => {
            expect($isSelectionInTable($getSelection())).toBe(false);
        });
    });

    it("is false for a null selection", () => {
        expect($isSelectionInTable(null)).toBe(false);
    });
});

describe("TABLE_OPS_TOOLBAR_BUTTONS", () => {
    it("has all 7 buttons enabled for an in-table selection and disabled for a paragraph selection", () => {
        expect(TABLE_OPS_TOOLBAR_BUTTONS).toHaveLength(7);
        const inTable = createEditorWithTableSelection();
        const inParagraph = createEditorWithParagraphSelection();
        for (const button of TABLE_OPS_TOOLBAR_BUTTONS) {
            inTable.getEditorState().read(() => {
                expect(button.interaction.isDisabled?.($getSelection(), inTable)).toBe(false);
            });
            inParagraph.getEditorState().read(() => {
                expect(button.interaction.isDisabled?.($getSelection(), inParagraph)).toBe(true);
            });
        }
    });
});
