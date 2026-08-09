import { $getRoot } from "lexical";
import { $isListItemNode, $isListNode } from "@lexical/list";
import { describe, expect, it } from "vitest";

import { $markdownToNodes } from "../../../../components/markdown-editor/markdown/markdownConversion";

import { createTestEditor, roundTrip } from "../markdownTestUtils";

describe("task list (check list, 2-space dialect)", () => {
    it.each(["- [ ] todo", "- [x] done", "- [ ] one\n- [x] two", "- [x] parent\n  - [ ] child"])(
        "round-trips %j",
        (markdown) => {
            expect(roundTrip(markdown)).toBe(markdown);
        }
    );

    it("imports - [ ] / - [x] as a check list with the checked state preserved", () => {
        const editor = createTestEditor();
        editor.update(() => $markdownToNodes("- [ ] a\n- [x] b"), { discrete: true });
        editor.getEditorState().read(() => {
            const list = $getRoot().getFirstChild();
            expect($isListNode(list)).toBe(true);
            if (!$isListNode(list)) {
                return;
            }
            expect(list.getListType()).toBe("check");
            const items = list.getChildren().filter($isListItemNode);
            expect(items).toHaveLength(2);
            expect(items[0]?.getChecked()).toBe(false);
            expect(items[1]?.getChecked()).toBe(true);
        });
    });

    it.each([
        ["[] todo", "- [ ] todo"],
        ["[ ] todo", "- [ ] todo"],
        ["[x] done", "- [x] done"],
        ["[X] done", "- [x] done"]
    ])("accepts brackets-first %j → %j (no leading dash needed)", (input, expected) => {
        expect(roundTrip(input)).toBe(expected);
    });

    it("leaves non-checkbox brackets as plain text", () => {
        expect(roundTrip("[foo] bar")).toBe("[foo] bar");
    });

    it("does not mistake a check item for a plain bullet (or vice versa)", () => {
        // `- [ ]` must match the check regexp before the bullet regexp, not become
        // a bullet item with literal "[ ]" text.
        expect(roundTrip("- [ ] task")).toBe("- [ ] task");
        expect(roundTrip("- plain")).toBe("- plain");
    });
});
