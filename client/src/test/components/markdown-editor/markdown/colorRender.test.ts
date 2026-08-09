import {
    $createParagraphNode,
    $createTextNode,
    $getRoot,
    $getSelection,
    $isRangeSelection,
    createEditor,
    type LexicalEditor
} from "lexical";
import { $patchStyleText } from "@lexical/selection";
import { AutoLinkNode, LinkNode } from "@lexical/link";
import { afterEach, describe, expect, it } from "vitest";

import { EditorNodes } from "@com.mgmtp.a12.widgets/widgets-core";

import { MARKDOWN_NODES } from "../../../../components/markdown-editor/markdown/markdownTransformers";
import { MARKDOWN_EDITOR_THEME } from "../../../../components/markdown-editor/theme/editorTheme";

// createDOM applies the inline `color` style only against a real DOM (the round-trip
// suite is headless), and A12's InlineStyleTextNode overrides createDOM — so this
// mounts an editable editor in jsdom to prove the color actually paints.
let mounted: { editor: LexicalEditor; root: HTMLElement } | null = null;

function mountEditor(): { editor: LexicalEditor; root: HTMLElement } {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = createEditor({
        namespace: "color-render-test",
        nodes: [...MARKDOWN_NODES, ...(EditorNodes ?? []), LinkNode, AutoLinkNode],
        theme: MARKDOWN_EDITOR_THEME,
        onError: (error) => {
            throw error;
        }
    });
    editor.setRootElement(root);
    mounted = { editor, root };
    return mounted;
}

afterEach(() => {
    mounted?.editor.setRootElement(null);
    mounted?.root.remove();
    mounted = null;
});

describe("text color rendering", () => {
    it("paints a stored inline color style on the rendered text run", () => {
        const { editor, root } = mountEditor();
        editor.update(
            () => {
                const paragraph = $createParagraphNode();
                paragraph.append($createTextNode("colored").setStyle("color: #ff0000;"));
                $getRoot().clear().append(paragraph);
            },
            { discrete: true }
        );

        const colored = root.querySelector<HTMLElement>('[style*="color"]');
        expect(colored?.textContent).toBe("colored");
        expect(colored?.style.color).toBeTruthy();
    });

    it("paints color applied to a selection via $patchStyleText (the picker path)", () => {
        const { editor, root } = mountEditor();
        editor.update(
            () => {
                const paragraph = $createParagraphNode();
                const text = $createTextNode("hi");
                paragraph.append(text);
                $getRoot().clear().append(paragraph);
                text.select(0, 2);
                const selection = $getSelection();
                if ($isRangeSelection(selection)) {
                    $patchStyleText(selection, { color: "#1971c2" });
                }
            },
            { discrete: true }
        );

        const colored = root.querySelector<HTMLElement>('[style*="color"]');
        expect(colored?.textContent).toBe("hi");
        expect(colored?.style.color).toBeTruthy();
    });
});
