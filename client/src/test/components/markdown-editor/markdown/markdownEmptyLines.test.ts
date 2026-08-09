import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import { describe, expect, it } from "vitest";

import { $markdownToNodes, $nodesToMarkdown } from "../../../../components/markdown-editor/markdown/markdownConversion";

import { createTestEditor, roundTrip } from "../markdownTestUtils";

describe("empty-line preservation (preserve-newlines dialect)", () => {
    /** Simulates editor-entered content: one paragraph per entry, null = empty paragraph (Enter Enter). */
    function exportParagraphs(texts: (string | null)[]): string {
        const editor = createTestEditor();
        editor.update(
            () => {
                const root = $getRoot();
                root.clear();
                for (const text of texts) {
                    const paragraph = $createParagraphNode();
                    if (text !== null) {
                        paragraph.append($createTextNode(text));
                    }
                    root.append(paragraph);
                }
            },
            { discrete: true }
        );
        let markdown = "";
        editor.getEditorState().read(() => {
            markdown = $nodesToMarkdown();
        });
        return markdown;
    }

    /** Top-level text contents after import, "" marking an empty paragraph. */
    function importedBlocks(markdown: string): string[] {
        const editor = createTestEditor();
        editor.update(() => $markdownToNodes(markdown), { discrete: true });
        let blocks: string[] = [];
        editor.getEditorState().read(() => {
            blocks = $getRoot()
                .getChildren()
                .map((child) => child.getTextContent());
        });
        return blocks;
    }

    it("serializes an editor-entered empty line as a blank line", () => {
        expect(exportParagraphs(["a", null, "b"])).toBe("a\n\nb");
    });

    it("serializes each consecutive empty line as its own blank line", () => {
        expect(exportParagraphs(["a", null, null, "b"])).toBe("a\n\n\nb");
    });

    it("serializes adjacent paragraphs newline-delimited (no blank line)", () => {
        expect(exportParagraphs(["a", "b"])).toBe("a\nb");
    });

    it("serializes a leading empty line", () => {
        expect(exportParagraphs([null, "a"])).toBe("\na");
    });

    it("imports every blank line as an empty paragraph", () => {
        expect(importedBlocks("a\n\nb")).toEqual(["a", "", "b"]);
        expect(importedBlocks("a\n\n\nb")).toEqual(["a", "", "", "b"]);
    });

    it("imports adjacent lines as separate paragraphs", () => {
        expect(importedBlocks("a\nb")).toEqual(["a", "b"]);
    });

    it.each(["a\nb", "a\n\nb", "a\n\n\nb", "\n\nlead", "# H\n\n\ntext", "- l1\n- l2\n\n\nafter"])(
        "round-trips %j byte-identically",
        (markdown) => {
            expect(roundTrip(markdown)).toBe(markdown);
        }
    );

    it("leaves blank lines inside code fences alone", () => {
        const code = "```\nline1\n\n\nline2\n```";
        expect(roundTrip(code)).toBe(code);
        expect(importedBlocks(code)).toEqual(["line1\n\n\nline2"]);
    });
});
