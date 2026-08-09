import {
    $createParagraphNode,
    $createRangeSelection,
    $createTextNode,
    $getRoot,
    $isElementNode,
    $setSelection
} from "lexical";
import { describe, expect, it } from "vitest";

import { $createAdmonitionNode, $isAdmonitionNode } from "../../../../components/markdown-editor/nodes/AdmonitionNode";
import { $applyAdmonitionVariant } from "../../../../components/markdown-editor/insertion/blockInsertion";

import { createTestEditor } from "../markdownTestUtils";

/** Build a root holding a single admonition of `type` with one body paragraph, caret inside it. */
function seedPanel(type: string, bodyText: string) {
    const editor = createTestEditor();
    editor.update(
        () => {
            const root = $getRoot();
            root.clear();
            const admonition = $createAdmonitionNode(type);
            const paragraph = $createParagraphNode();
            paragraph.append($createTextNode(bodyText));
            admonition.append(paragraph);
            root.append(admonition);
            paragraph.selectEnd();
        },
        { discrete: true }
    );
    return editor;
}

/** Text content of each child block of the first (panel) node at root. */
function panelBodyTexts(editor: ReturnType<typeof createTestEditor>): string[] {
    let texts: string[] = [];
    editor.getEditorState().read(() => {
        const panel = $getRoot().getFirstChild();
        if ($isElementNode(panel)) {
            texts = panel.getChildren().map((node) => node.getTextContent());
        }
    });
    return texts;
}

function rootChildren(editor: ReturnType<typeof createTestEditor>) {
    let result: { type: string; admonitionType?: string; text: string }[] = [];
    editor.getEditorState().read(() => {
        result = $getRoot()
            .getChildren()
            .map((node) => ({
                type: node.getType(),
                admonitionType: $isAdmonitionNode(node) ? node.getAdmonitionType() : undefined,
                text: node.getTextContent()
            }));
    });
    return result;
}

describe("$applyAdmonitionVariant (Panel toolbar)", () => {
    it("retypes the current panel in place instead of adding a new one", () => {
        const editor = seedPanel("info", "hi");
        editor.update(() => $applyAdmonitionVariant("warning"), { discrete: true });

        const children = rootChildren(editor);
        expect(children).toHaveLength(1);
        expect(children[0]).toMatchObject({ type: "admonition", admonitionType: "warning", text: "hi" });
    });

    it("toggles off (unwraps) the panel when re-applying its current variant", () => {
        const editor = seedPanel("info", "hi");
        editor.update(() => $applyAdmonitionVariant("info"), { discrete: true });

        const children = rootChildren(editor);
        expect(children.some((c) => c.type === "admonition")).toBe(false);
        expect(children.map((c) => c.text)).toContain("hi");
    });

    /** Build a root of paragraphs from `texts`, then select from the start of the first to a
     * point in the last (offset `lastOffset`, default = whole last paragraph). */
    function seedSelection(texts: string[], lastOffset?: number) {
        const editor = createTestEditor();
        editor.update(
            () => {
                const root = $getRoot();
                root.clear();
                const paragraphs = texts.map((text) => {
                    const paragraph = $createParagraphNode();
                    paragraph.append($createTextNode(text));
                    root.append(paragraph);
                    return paragraph;
                });
                const firstText = paragraphs[0]?.getFirstChild();
                const lastParagraph = paragraphs[paragraphs.length - 1];
                const lastText = lastParagraph?.getFirstChild();
                if (!firstText || !lastText) {
                    return;
                }
                const selection = $createRangeSelection();
                selection.anchor.set(firstText.getKey(), 0, "text");
                selection.focus.set(lastText.getKey(), lastOffset ?? lastText.getTextContent().length, "text");
                $setSelection(selection);
            },
            { discrete: true }
        );
        return editor;
    }

    it("encloses a multi-block selection in a single panel, preserving order", () => {
        const editor = seedSelection(["one", "two", "three"]);
        editor.update(() => $applyAdmonitionVariant("note"), { discrete: true });

        const children = rootChildren(editor);
        // The panel, plus a trailing escape paragraph (it ends the document).
        expect(children).toHaveLength(2);
        expect(children[0]).toMatchObject({ type: "admonition", admonitionType: "note" });
        expect(children[1]).toMatchObject({ type: "paragraph", text: "" });
        expect(panelBodyTexts(editor)).toEqual(["one", "two", "three"]);
    });

    it("encloses the whole block even when only part of its text is selected", () => {
        const editor = seedSelection(["hello world"], 5); // select just "hello"
        editor.update(() => $applyAdmonitionVariant("warning"), { discrete: true });

        const children = rootChildren(editor);
        expect(children[0]).toMatchObject({ type: "admonition", admonitionType: "warning", text: "hello world" });
        // A trailing escape paragraph follows the panel that now ends the document.
        expect(children[children.length - 1]).toMatchObject({ type: "paragraph", text: "" });
    });

    it("inserts a new panel when the caret is not inside one", () => {
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
        editor.update(() => $applyAdmonitionVariant("tip"), { discrete: true });

        const children = rootChildren(editor);
        const panels = children.filter((c) => c.type === "admonition");
        expect(panels).toHaveLength(1);
        expect(panels[0]?.admonitionType).toBe("tip");
        expect(children.map((c) => c.text)).toContain("plain");
    });
});
