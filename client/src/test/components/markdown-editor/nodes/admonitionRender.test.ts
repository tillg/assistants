import { AutoLinkNode, LinkNode } from "@lexical/link";
import {
    $createParagraphNode,
    $createTextNode,
    $getNodeByKey,
    $getRoot,
    createEditor,
    type LexicalEditor
} from "lexical";
import { afterEach, describe, expect, it } from "vitest";

import { EditorNodes } from "@com.mgmtp.a12.widgets/widgets-core";

import { $createAdmonitionNode, $isAdmonitionNode } from "../../../../components/markdown-editor/nodes/AdmonitionNode";
import { MARKDOWN_NODES } from "../../../../components/markdown-editor/markdown/markdownTransformers";
import { MARKDOWN_EDITOR_THEME } from "../../../../components/markdown-editor/theme/editorTheme";

// createDOM/getDOMSlot run only against a real DOM (the markdown round-trip suite
// is headless and never exercises them), so this mounts an editable editor in jsdom.
let mounted: { editor: LexicalEditor; root: HTMLElement } | null = null;

function mountEditor(): { editor: LexicalEditor; root: HTMLElement } {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = createEditor({
        namespace: "admonition-render-test",
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

/** Insert one admonition of `type` with a single-paragraph body; returns its key. */
function insertAdmonition(editor: LexicalEditor, type: string, body = "Body text."): string {
    let key = "";
    editor.update(
        () => {
            const root = $getRoot();
            root.clear();
            const admonition = $createAdmonitionNode(type);
            const paragraph = $createParagraphNode();
            paragraph.append($createTextNode(body));
            admonition.append(paragraph);
            root.append(admonition);
            key = admonition.getKey();
        },
        { discrete: true }
    );
    return key;
}

afterEach(() => {
    mounted?.editor.setRootElement(null);
    mounted?.root.remove();
    mounted = null;
});

describe("AdmonitionNode rendering", () => {
    it("renders a non-editable header (icon + label) before the editable body", () => {
        const { editor, root } = mountEditor();
        insertAdmonition(editor, "info");

        const admonition = root.querySelector<HTMLElement>(".md-editor-admonition");
        expect(admonition).not.toBeNull();
        expect(admonition?.getAttribute("data-admonition-type")).toBe("info");

        const header = admonition?.firstElementChild as HTMLElement;
        expect(header.className).toBe("md-editor-admonition-header");
        expect(header.contentEditable).toBe("false");
        expect(header.children[0]?.textContent).toBe("info"); // Material Icons ligature
        expect(header.children[1]?.textContent).toBe("Info"); // variant label

        // The body paragraph is reconciled after the header, not over it.
        expect(admonition?.children.length).toBe(2);
        expect(admonition?.children[1]?.textContent).toContain("Body text.");
    });

    it("falls back to a neutral panel for unknown variant types", () => {
        const { editor, root } = mountEditor();
        insertAdmonition(editor, "totally-custom");

        const header = root.querySelector(".md-editor-admonition-header");
        expect(header?.children[0]?.textContent).toBe("web_asset");
        expect(header?.children[1]?.textContent).toBe("Panel");
    });

    it("updates the header in place when the variant type changes", () => {
        const { editor, root } = mountEditor();
        const key = insertAdmonition(editor, "info");

        editor.update(
            () => {
                const node = $getNodeByKey(key);
                if ($isAdmonitionNode(node)) {
                    node.setAdmonitionType("warning");
                }
            },
            { discrete: true }
        );

        const admonition = root.querySelector<HTMLElement>(".md-editor-admonition");
        expect(admonition?.getAttribute("data-admonition-type")).toBe("warning");
        const header = admonition?.firstElementChild;
        expect(header?.children[0]?.textContent).toBe("warning");
        expect(header?.children[1]?.textContent).toBe("Warning");
        expect(admonition?.children.length).toBe(2); // body survives the header swap
    });
});
