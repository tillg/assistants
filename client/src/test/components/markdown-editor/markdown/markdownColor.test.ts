import {
    $createParagraphNode,
    $createTextNode,
    $getRoot,
    $getSelection,
    $isElementNode,
    $isRangeSelection,
    $isTextNode,
    type LexicalNode
} from "lexical";
import { $patchStyleText } from "@lexical/selection";
import { describe, expect, it } from "vitest";

import { $isInlineStyleTextNode } from "@com.mgmtp.a12.widgets/widgets-core";

import {
    extractColor,
    isValidColor,
    isValidHexColor
} from "../../../../components/markdown-editor/markdown/colorTransformer";
import { $markdownToNodes, $nodesToMarkdown } from "../../../../components/markdown-editor/markdown/markdownConversion";

import { createTestEditor, roundTrip } from "../markdownTestUtils";

/** A text run carrying a color style — the shape the COLOR transformer produces on import. */
const isColoredRun = (node: LexicalNode) => $isInlineStyleTextNode(node) && extractColor(node.getStyle()) !== null;

/** The first child text node of `paragraph` whose text content equals `text`. */
function childTextNode(paragraph: LexicalNode | null, text: string): LexicalNode | undefined {
    if (!$isElementNode(paragraph)) {
        return undefined;
    }
    return paragraph.getChildren().find((node) => $isTextNode(node) && node.getTextContent() === text);
}

describe("COLOR transformer", () => {
    it.each([
        ':color[red text]{value="#ff0000"}',
        'before :color[middle]{value="#1971c2"} after',
        ':color[short hex]{value="#f00"}',
        // CSS color names round-trip verbatim (stored lowercased).
        ':color[warn]{value="orange"}',
        'see :color[teal word]{value="teal"} here',
        // Color composes with inline marks — the bracket content carries the format markers.
        ':color[**bold**]{value="#9c36b5"}',
        ':color[_italic_]{value="red"}',
        ':color[~~struck~~]{value="#f00"}'
    ])("round-trips %j", (markdown) => {
        expect(roundTrip(markdown)).toBe(markdown);
    });

    it("parses :color[..]{value=#hex} into a text run carrying the color style", () => {
        const editor = createTestEditor();
        editor.update(() => $markdownToNodes(':color[hello]{value="#ff0000"}'), { discrete: true });
        editor.getEditorState().read(() => {
            const paragraph = $getRoot().getFirstChild();
            const textNode = $isElementNode(paragraph) ? paragraph.getChildren().find($isTextNode) : undefined;
            expect(textNode?.getTextContent()).toBe("hello");
            expect(extractColor(textNode?.getStyle() ?? "")).toBe("#ff0000");
        });
    });

    it("parses :color with a CSS color name into a name-styled run", () => {
        const editor = createTestEditor();
        editor.update(() => $markdownToNodes(':color[hello]{value="teal"}'), { discrete: true });
        editor.getEditorState().read(() => {
            const paragraph = $getRoot().getFirstChild();
            const textNode = $isElementNode(paragraph) ? paragraph.getChildren().find($isTextNode) : undefined;
            expect(textNode?.getTextContent()).toBe("hello");
            expect(extractColor(textNode?.getStyle() ?? "")).toBe("teal");
        });
    });

    it("parses :color[**text**] into a run that is both bold and colored", () => {
        const editor = createTestEditor();
        editor.update(() => $markdownToNodes(':color[hi]{value="#ff0000"} :color[**bold**]{value="#00ff00"}'), {
            discrete: true
        });
        editor.getEditorState().read(() => {
            const bold = childTextNode($getRoot().getFirstChild(), "bold");
            expect(bold && $isTextNode(bold) && bold.hasFormat("bold")).toBe(true);
            expect(extractColor((bold && $isTextNode(bold) && bold.getStyle()) || "")).toBe("#00ff00");
        });
    });

    // A12's editor merges adjacent simple-text InlineStyleTextNodes (its
    // TextFormatPlugin mutation listener) ignoring inline style, which would drop a
    // mid-paragraph color. The imported colored run must be marked unmergeable so it
    // survives sitting between plain neighbors.
    it("marks an imported colored run unmergeable", () => {
        const editor = createTestEditor();
        editor.update(() => $markdownToNodes('hello :color[world]{value="#ff0000"} foo'), { discrete: true });
        editor.getEditorState().read(() => {
            const paragraph = $getRoot().getFirstChild();
            const colored = $isElementNode(paragraph) ? paragraph.getChildren().find(isColoredRun) : undefined;
            expect(colored && $isInlineStyleTextNode(colored) && colored.isCustomUnmergeable()).toBe(true);
        });
    });

    // Color wrapping a MIX of formats (partial span) renders correctly but is not
    // byte-stable on cycle 1: it canonicalizes to one `:color[…]` per resulting run.
    // It must still be cycle-2 stable (AC 5). Whole-span composition (above) is
    // byte-stable on cycle 1; only mixed inner formatting canonicalizes.
    it.each([':color[a **b** c]{value="red"}', ':color[**b** and _i_]{value="teal"}'])(
        "canonicalizes mixed-span color %j but stays cycle-2 stable",
        (markdown) => {
            const cycle1 = roundTrip(markdown);
            expect(roundTrip(cycle1)).toBe(cycle1);
        }
    );

    // A value that is neither a hex nor a CSS color name is rejected in `replace`
    // and survives as literal text (degrade-for-free, like unknown block directives).
    // `16:00` / `:2` prove the name-specific `:color[` start never mis-parses
    // colon-bearing prose.
    it.each([
        ':color[x]{value="#12"}',
        ':color[x]{value="rgb(1,2,3)"}',
        ':color[x]{value="chartreusish"}',
        "Meeting at 16:00 in room :2"
    ])("leaves %j untouched as plain text", (markdown) => {
        expect(roundTrip(markdown)).toBe(markdown);
    });

    // Color composes with other inline formats on the same run — a bold + colored
    // run serializes with the bold marker inside the directive brackets.
    it("exports a bold + colored run with the bold marker inside the directive", () => {
        const editor = createTestEditor();
        editor.update(
            () => {
                const root = $getRoot();
                root.clear();
                const paragraph = $createParagraphNode();
                const text = $createTextNode("emph").setStyle("color: #9c36b5;");
                text.toggleFormat("bold");
                paragraph.append(text);
                root.append(paragraph);
            },
            { discrete: true }
        );
        let md = "";
        editor.getEditorState().read(() => {
            md = $nodesToMarkdown();
        });
        expect(md).toBe(':color[**emph**]{value="#9c36b5"}');
    });

    // Coloring a sub-range of a paragraph splits the run and colors only that word
    // (the picker applies $patchStyleText the same way); the rest stays plain.
    it("colors only the selected word within a paragraph", () => {
        const editor = createTestEditor();
        editor.update(
            () => {
                const root = $getRoot();
                root.clear();
                const paragraph = $createParagraphNode();
                const text = $createTextNode("hello world foo");
                paragraph.append(text);
                root.append(paragraph);
                text.select(6, 11); // "world"
                const selection = $getSelection();
                if ($isRangeSelection(selection)) {
                    $patchStyleText(selection, { color: "#1971c2" });
                }
            },
            { discrete: true }
        );
        let md = "";
        editor.getEditorState().read(() => {
            md = $nodesToMarkdown();
        });
        expect(md).toBe('hello :color[world]{value="#1971c2"} foo');
    });

    // Text containing `]` isn't escaped (documented, like IMAGE alt-text); must stay cycle-stable.
    it("is cycle-stable for colored text containing ]", () => {
        const md1 = roundTrip(':color[a]b]{value="#ff0000"}');
        expect(roundTrip(md1)).toBe(md1);
    });

    it("survives a JSON serialization round-trip (color style preserved)", () => {
        const editor = createTestEditor();
        editor.update(() => $markdownToNodes(':color[hello]{value="#ff0000"}'), { discrete: true });
        const json = JSON.stringify(editor.getEditorState().toJSON());
        expect(json).toContain("color: #ff0000");
        const restored = editor.parseEditorState(json);
        editor.setEditorState(restored);
        editor.getEditorState().read(() => {
            expect(JSON.stringify(editor.getEditorState().toJSON())).toBe(json);
        });
    });
});

describe("color helpers", () => {
    it.each(["#fff", "#ffffff", "#1971c2", "#ABC"])("isValidHexColor accepts %j", (value) => {
        expect(isValidHexColor(value)).toBe(true);
    });

    it.each(["fff", "#12", "#1234", "teal", "rgb(0,0,0)", ""])("isValidHexColor rejects %j", (value) => {
        expect(isValidHexColor(value)).toBe(false);
    });

    it.each(["#fff", "#1971c2", "#ABC", "teal", "red", "REBECCAPURPLE", "  Orange  "])(
        "isValidColor accepts hex or CSS name %j",
        (value) => {
            expect(isValidColor(value)).toBe(true);
        }
    );

    it.each(["fff", "#12", "rgb(0,0,0)", "chartreusish", "notacolor", ""])("isValidColor rejects %j", (value) => {
        expect(isValidColor(value)).toBe(false);
    });

    it.each([
        ["color: #ff0000;", "#ff0000"],
        ["font-weight: bold; color: #1971c2;", "#1971c2"],
        ["color: #abc", "#abc"],
        ["color: red;", "red"],
        ["color: teal;", "teal"],
        ["color: rgb(1,2,3);", null],
        ["font-weight: bold;", null],
        ["", null]
    ] as const)("extractColor(%j) → %j", (style, expected) => {
        expect(extractColor(style)).toBe(expected);
    });
});
