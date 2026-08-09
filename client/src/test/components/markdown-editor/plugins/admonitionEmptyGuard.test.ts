import {
    $createParagraphNode,
    $createTextNode,
    $getRoot,
    $getSelection,
    $isRangeSelection,
    type LexicalEditor
} from "lexical";
import { describe, expect, it } from "vitest";

import { $createAdmonitionNode, $isAdmonitionNode } from "../../../../components/markdown-editor/nodes/AdmonitionNode";
import { registerAdmonitionEmptyGuard } from "../../../../components/markdown-editor/plugins/AdmonitionEmptyGuardPlugin";

import { createTestEditor } from "../markdownTestUtils";

/** A panel with one text paragraph, guard registered, its key returned. */
function setupPanel(editor: LexicalEditor): string {
    registerAdmonitionEmptyGuard(editor);
    let key = "";
    editor.update(
        () => {
            const root = $getRoot();
            root.clear();
            const admonition = $createAdmonitionNode("info");
            admonition.append($createParagraphNode().append($createTextNode("body")));
            root.append(admonition);
            key = admonition.getKey();
        },
        { discrete: true }
    );
    return key;
}

function panelChildTypes(editor: LexicalEditor): string[] {
    let types: string[] = [];
    editor.getEditorState().read(() => {
        const panel = $getRoot().getFirstChild();
        types = $isAdmonitionNode(panel) ? panel.getChildren().map((child) => child.getType()) : [];
    });
    return types;
}

describe("registerAdmonitionEmptyGuard", () => {
    it("re-adds an empty paragraph when a panel's last block is removed", () => {
        const editor = createTestEditor();
        setupPanel(editor);

        editor.update(
            () => {
                const panel = $getRoot().getFirstChild();
                if ($isAdmonitionNode(panel)) {
                    for (const child of panel.getChildren()) {
                        child.remove();
                    }
                }
            },
            { discrete: true }
        );

        // The panel survives with a single empty paragraph rather than a childless node.
        expect(panelChildTypes(editor)).toEqual(["paragraph"]);
        editor.getEditorState().read(() => {
            const panel = $getRoot().getFirstChild();
            expect($isAdmonitionNode(panel) && panel.getFirstChild()?.getTextContent()).toBe("");
        });
    });

    it("lands the caret in the re-added paragraph", () => {
        const editor = createTestEditor();
        setupPanel(editor);

        editor.update(
            () => {
                const panel = $getRoot().getFirstChild();
                if ($isAdmonitionNode(panel)) {
                    // Anchor the selection on the panel itself, as node removal does, then empty it.
                    panel.select();
                    for (const child of panel.getChildren()) {
                        child.remove();
                    }
                }
            },
            { discrete: true }
        );

        let caretInPanelBody = false;
        editor.getEditorState().read(() => {
            const selection = $getSelection();
            const panel = $getRoot().getFirstChild();
            if ($isRangeSelection(selection) && $isAdmonitionNode(panel)) {
                caretInPanelBody = selection.anchor.getNode().is(panel.getFirstChild());
            }
        });
        expect(caretInPanelBody).toBe(true);
    });

    it("leaves a non-empty panel untouched", () => {
        const editor = createTestEditor();
        setupPanel(editor);

        editor.update(
            () => {
                const panel = $getRoot().getFirstChild();
                if ($isAdmonitionNode(panel)) {
                    panel.append($createParagraphNode().append($createTextNode("second")));
                }
            },
            { discrete: true }
        );

        expect(panelChildTypes(editor)).toEqual(["paragraph", "paragraph"]);
    });
});
