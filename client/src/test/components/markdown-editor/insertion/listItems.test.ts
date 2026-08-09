import { $createListItemNode, $createListNode } from "@lexical/list";
import { $createParagraphNode, $createTextNode, $getRoot, $getSelection } from "lexical";
import { describe, expect, it } from "vitest";

import { $isListActive, $toggleList, LIST_ITEMS } from "../../../../components/markdown-editor/insertion/listItems";

import { createTestEditor } from "../markdownTestUtils";

const BULLET = LIST_ITEMS.find((def) => def.listType === "bullet")!;
const NUMBER = LIST_ITEMS.find((def) => def.listType === "number")!;

function seedBulletList(editor: ReturnType<typeof createTestEditor>): void {
    editor.update(
        () => {
            const root = $getRoot();
            root.clear();
            const list = $createListNode("bullet");
            const item = $createListItemNode();
            item.append($createTextNode("item"));
            list.append(item);
            root.append(list);
            item.selectEnd();
        },
        { discrete: true }
    );
}

function rootTypes(editor: ReturnType<typeof createTestEditor>): string[] {
    let types: string[] = [];
    editor.getEditorState().read(() => {
        types = $getRoot()
            .getChildren()
            .map((node) => node.getType());
    });
    return types;
}

describe("list items — toggle + active state", () => {
    it("reports active only for the matching list type", () => {
        const editor = createTestEditor();
        seedBulletList(editor);
        editor.getEditorState().read(() => {
            const selection = $getSelection();
            expect($isListActive(BULLET, selection)).toBe(true);
            expect($isListActive(NUMBER, selection)).toBe(false);
        });
    });

    it("is inactive in an ordinary paragraph", () => {
        const editor = createTestEditor();
        editor.update(
            () => {
                const root = $getRoot();
                root.clear();
                const paragraph = $createParagraphNode();
                paragraph.append($createTextNode("plain"));
                root.append(paragraph);
                paragraph.selectEnd();
            },
            { discrete: true }
        );
        editor.getEditorState().read(() => {
            expect($isListActive(BULLET, $getSelection())).toBe(false);
        });
    });

    // The reported bug: the shortcut/slash path could not remove a list it had created.
    it("toggles an existing list back to paragraphs (removal path, no command handler needed)", () => {
        const editor = createTestEditor();
        seedBulletList(editor);
        expect(rootTypes(editor)).toContain("list");
        editor.update(() => $toggleList(editor, BULLET), { discrete: true });
        expect(rootTypes(editor)).not.toContain("list");
        expect(rootTypes(editor)).toContain("paragraph");
    });
});
