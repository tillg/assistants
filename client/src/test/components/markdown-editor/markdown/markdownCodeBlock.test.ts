import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import { $isCodeNode } from "@lexical/code";
import { describe, expect, it } from "vitest";

import { $convertCodeFenceLine } from "../../../../components/markdown-editor/plugins/BlockMarkdownEnterPlugin";

import { convertOnEnter, createTestEditor } from "../markdownTestUtils";

describe("code block on Enter (multiline-shortcut backport)", () => {
    it.each(["```", "```js", "```typescript"])("converts a bare %j fence at caret-end into a code block", (line) => {
        const { converted, types } = convertOnEnter(line, $convertCodeFenceLine);
        expect(converted).toBe(true);
        expect(types).toContain("code");
    });

    it("carries the fence language onto the code block", () => {
        const editor = createTestEditor();
        editor.update(
            () => {
                const root = $getRoot();
                root.clear();
                const paragraph = $createParagraphNode();
                paragraph.append($createTextNode("```ts"));
                root.append(paragraph);
                paragraph.selectEnd();
                $convertCodeFenceLine();
            },
            { discrete: true }
        );
        editor.getEditorState().read(() => {
            const code = $getRoot().getChildren().find($isCodeNode);
            expect(code?.getLanguage()).toBe("ts");
        });
    });

    it("leaves a non-fence paragraph unchanged", () => {
        const { converted, types } = convertOnEnter("not a fence", $convertCodeFenceLine);
        expect(converted).toBe(false);
        expect(types).not.toContain("code");
    });
});
