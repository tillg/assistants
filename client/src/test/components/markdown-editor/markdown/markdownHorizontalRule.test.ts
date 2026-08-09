import { $getRoot } from "lexical";
import { $isHorizontalRuleNode } from "@lexical/extension";
import { describe, expect, it } from "vitest";

import { $markdownToNodes } from "../../../../components/markdown-editor/markdown/markdownConversion";
import { $convertHorizontalRuleLine } from "../../../../components/markdown-editor/plugins/BlockMarkdownEnterPlugin";

import { convertOnEnter, createTestEditor, roundTrip } from "../markdownTestUtils";

describe("horizontal rule", () => {
    it("round-trips --- between paragraphs", () => {
        expect(roundTrip("before\n\n---\n\nafter")).toBe("before\n\n---\n\nafter");
    });

    it.each(["***", "___"])("imports %j and canonicalizes it to ---", (rule) => {
        expect(roundTrip(`a\n\n${rule}\n\nb`)).toBe("a\n\n---\n\nb");
    });

    it("parses --- into a HorizontalRuleNode", () => {
        const editor = createTestEditor();
        editor.update(() => $markdownToNodes("a\n\n---\n\nb"), { discrete: true });
        editor.getEditorState().read(() => {
            expect($getRoot().getChildren().some($isHorizontalRuleNode)).toBe(true);
        });
    });
});

describe("horizontal rule on Enter (0.45.0 backport)", () => {
    it.each(["---", "***", "___"])("converts a bare %j line at caret-end into a rule", (line) => {
        const { converted, types } = convertOnEnter(line, $convertHorizontalRuleLine);
        expect(converted).toBe(true);
        expect(types).toContain("horizontalrule");
    });

    it("leaves a normal paragraph unchanged", () => {
        const { converted, types } = convertOnEnter("just text", $convertHorizontalRuleLine);
        expect(converted).toBe(false);
        expect(types).not.toContain("horizontalrule");
    });
});
