import { $getRoot, $isElementNode } from "lexical";
import { describe, expect, it } from "vitest";

import { $isImageNode } from "../../../../components/markdown-editor/nodes/ImageNode";
import { $markdownToNodes } from "../../../../components/markdown-editor/markdown/markdownConversion";

import { createTestEditor, roundTrip } from "../markdownTestUtils";

describe("IMAGE transformer", () => {
    it.each([
        "![alt text](https://example.com/x.png)",
        "![](https://example.com/no-alt.png)",
        "before ![inline](https://e.com/i.png) after",
        "| ![img](https://e.com/i.png) | b |\n| --- | --- |\n| 1 | 2 |",
        // src may contain (single-level) balanced parens, e.g. Wikipedia-style URLs
        "![cat](https://en.wikipedia.org/wiki/Cat_(animal).png)",
        "![a](https://e.com/img(1).png)",
        // attachment:<id> sources are opaque to the transformer and round-trip like any other src
        "![diagram.png](attachment:7f3a9c21)"
    ])("round-trips %j", (markdown) => {
        expect(roundTrip(markdown)).toBe(markdown);
    });

    // Alt-text edge cases: the export does not escape ] or )
    // (documented deviation), but these forms must at least stay cycle-stable.
    it.each(["![a]b](https://e.com/i.png)", '![alt](https://e.com/i.png "title")'])(
        "is cycle-stable for %j",
        (markdown) => {
            const md1 = roundTrip(markdown);
            expect(roundTrip(md1)).toBe(md1);
        }
    );

    // Round-trips alone pass trivially while image markdown stays literal text,
    // so assert the markdown actually becomes an ImageNode with src/alt intact.
    it("parses ![alt](src) into an ImageNode", () => {
        const editor = createTestEditor();
        editor.update(() => $markdownToNodes("![alt text](https://example.com/x.png)"), { discrete: true });
        editor.getEditorState().read(() => {
            const paragraph = $getRoot().getFirstChild();
            const image = $isElementNode(paragraph) ? paragraph.getChildren().find($isImageNode) : undefined;
            expect(image).toBeDefined();
            expect(image?.getSrc()).toBe("https://example.com/x.png");
            expect(image?.getAltText()).toBe("alt text");
        });
    });

    // an attachment:<id> reference is a normal image to the transformer; the src is preserved
    // verbatim so the ImageNode can resolve it to a download link at render time.
    it("preserves an attachment:<id> src through the transformer", () => {
        const editor = createTestEditor();
        editor.update(() => $markdownToNodes("![diagram.png](attachment:7f3a9c21)"), { discrete: true });
        editor.getEditorState().read(() => {
            const paragraph = $getRoot().getFirstChild();
            const image = $isElementNode(paragraph) ? paragraph.getChildren().find($isImageNode) : undefined;
            expect(image?.getSrc()).toBe("attachment:7f3a9c21");
            expect(image?.getAltText()).toBe("diagram.png");
        });
    });

    it("survives a JSON serialization round-trip (exportJSON/importJSON)", () => {
        const editor = createTestEditor();
        editor.update(() => $markdownToNodes("![alt text](https://example.com/x.png)"), { discrete: true });
        const json = JSON.stringify(editor.getEditorState().toJSON());
        expect(json).toContain('"type":"image"');
        const restored = editor.parseEditorState(json);
        editor.setEditorState(restored);
        editor.getEditorState().read(() => {
            expect(JSON.stringify(editor.getEditorState().toJSON())).toBe(json);
        });
    });
});
