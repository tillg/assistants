import { AutoLinkNode, LinkNode } from "@lexical/link";
import { $createParagraphNode, $createTextNode, $getRoot, createEditor, type LexicalEditor } from "lexical";
import { afterEach, describe, expect, it } from "vitest";

import { EditorNodes } from "@com.mgmtp.a12.widgets/widgets-core";

import { $createAdmonitionNode, $isAdmonitionNode } from "../../../../components/markdown-editor/nodes/AdmonitionNode";
import { registerAdmonitionEmptyGuard } from "../../../../components/markdown-editor/plugins/AdmonitionEmptyGuardPlugin";
import { MARKDOWN_NODES } from "../../../../components/markdown-editor/markdown/markdownTransformers";
import { MARKDOWN_EDITOR_THEME } from "../../../../components/markdown-editor/theme/editorTheme";

// Exercises real DOM selection resolution (not just node state), so it needs a
// DOM-mounted editor rather than the headless one used by the other guard tests.
let mounted: { editor: LexicalEditor; root: HTMLElement; errors: unknown[] } | null = null;

function mountEditor(withGuard: boolean): { editor: LexicalEditor; root: HTMLElement; errors: unknown[] } {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const errors: unknown[] = [];
    const editor = createEditor({
        namespace: "empty-panel-click-test",
        nodes: [...MARKDOWN_NODES, ...(EditorNodes ?? []), LinkNode, AutoLinkNode],
        theme: MARKDOWN_EDITOR_THEME,
        onError: (error) => errors.push(error)
    });
    editor.setRootElement(root);
    if (withGuard) {
        registerAdmonitionEmptyGuard(editor);
    }
    mounted = { editor, root, errors };
    return mounted;
}

/** Insert a panel with a one-line body, then delete that line — the emptied-panel state. */
function insertThenEmptyPanel(editor: LexicalEditor): void {
    editor.update(
        () => {
            const rootNode = $getRoot();
            rootNode.clear();
            const admonition = $createAdmonitionNode("info");
            admonition.append($createParagraphNode().append($createTextNode("x")));
            rootNode.append(admonition);
        },
        { discrete: true }
    );
    editor.update(
        () => {
            const panel = $getRoot().getFirstChild();
            if ($isAdmonitionNode(panel)) {
                panel.getFirstChild()?.remove();
            }
        },
        { discrete: true }
    );
}

/**
 * Reproduce "click back into the panel": point the browser selection at the
 * admonition container itself (offset 0, where the non-editable title row sits)
 * and fire selectionchange, which drives Lexical's DOM-selection resolution.
 */
function clickIntoPanelContainer(root: HTMLElement): void {
    const panelDom = root.querySelector<HTMLElement>(".md-editor-admonition");
    expect(panelDom).not.toBeNull();
    const range = document.createRange();
    range.setStart(panelDom!, 0);
    range.collapse(true);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
}

afterEach(() => {
    mounted?.editor.setRootElement(null);
    mounted?.root.remove();
    mounted = null;
});

describe("clicking into an emptied panel", () => {
    it("without the guard, resolving the click throws $validatePoint (offset 1 > 0 children)", () => {
        const { editor, root, errors } = mountEditor(false);
        insertThenEmptyPanel(editor);
        clickIntoPanelContainer(root);
        // The non-editable title row shifts the managed-children region, so a
        // childless panel resolves the click to the out-of-range point (panel, 1).
        expect(errors.map(String).join("\n")).toContain("getChildrenSize");
    });

    it("with the guard, the panel keeps an empty paragraph and the click resolves cleanly", () => {
        const { editor, root, errors } = mountEditor(true);
        insertThenEmptyPanel(editor);
        clickIntoPanelContainer(root);
        expect(errors).toEqual([]);
    });
});
