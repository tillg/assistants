import { $createHorizontalRuleNode } from "@lexical/extension";
import {
    $createNodeSelection,
    $createParagraphNode,
    $createRangeSelection,
    $createTextNode,
    $getRoot,
    $getSelection,
    $isElementNode,
    $isRangeSelection,
    $setSelection
} from "lexical";
import { describe, expect, it } from "vitest";

import { $createTocNode } from "../../../../components/markdown-editor/nodes/TocNode";
import { $toggleTableOfContents } from "../../../../components/markdown-editor/insertion/blockInsertion";

import { createTestEditor } from "../markdownTestUtils";

/** root = [paragraph "before", toc, paragraph "after"]; returns the editor + the TOC key. */
function seedToc() {
    const editor = createTestEditor();
    let tocKey = "";
    editor.update(
        () => {
            const root = $getRoot();
            root.clear();
            const before = $createParagraphNode();
            before.append($createTextNode("before"));
            root.append(before);
            const toc = $createTocNode(1, 6);
            root.append(toc);
            tocKey = toc.getKey();
            const after = $createParagraphNode();
            after.append($createTextNode("after"));
            root.append(after);
        },
        { discrete: true }
    );
    return { editor, tocKey };
}

function rootTypes(editor: ReturnType<typeof createTestEditor>): string[] {
    let types: string[] = [];
    editor.getEditorState().read(() => {
        types = $getRoot()
            .getChildren()
            .map((node) => node.getType());
    });
    return types;
}

/** Type of the range-selection anchor's top-level block, or null when the anchor sits on the root. */
function anchorTopLevelType(editor: ReturnType<typeof createTestEditor>): string | null {
    let type: string | null = null;
    editor.getEditorState().read(() => {
        const selection = $getSelection();
        type = $isRangeSelection(selection)
            ? (selection.anchor.getNode().getTopLevelElement()?.getType() ?? null)
            : null;
    });
    return type;
}

describe("$toggleTableOfContents (TOC toolbar)", () => {
    it("removes a node-selected TOC instead of inserting another", () => {
        const { editor, tocKey } = seedToc();
        editor.update(
            () => {
                const selection = $createNodeSelection();
                selection.add(tocKey);
                $setSelection(selection);
                $toggleTableOfContents();
            },
            { discrete: true }
        );
        expect(rootTypes(editor)).toEqual(["paragraph", "paragraph"]);
    });

    it("removes the TOC when a range selection spans it", () => {
        const { editor } = seedToc();
        editor.update(
            () => {
                // Select from the "before" paragraph across the TOC into "after".
                const [before, , after] = $getRoot().getChildren();
                const beforeText = $isElementNode(before) ? before.getFirstChild() : null;
                const afterText = $isElementNode(after) ? after.getFirstChild() : null;
                if (beforeText === null || afterText === null) {
                    throw new Error("seed paragraphs missing text");
                }
                const selection = $createRangeSelection();
                selection.anchor.set(beforeText.getKey(), 0, "text");
                selection.focus.set(afterText.getKey(), afterText.getTextContent().length, "text");
                $setSelection(selection);
                $toggleTableOfContents();
            },
            { discrete: true }
        );
        expect(rootTypes(editor).filter((type) => type === "toc")).toHaveLength(0);
    });

    it("inserts a TOC when the caret is in an ordinary paragraph", () => {
        const editor = createTestEditor();
        editor.update(
            () => {
                const root = $getRoot();
                root.clear();
                const paragraph = $createParagraphNode();
                paragraph.append($createTextNode("plain"));
                root.append(paragraph);
                paragraph.selectEnd();
                $toggleTableOfContents();
            },
            { discrete: true }
        );
        expect(rootTypes(editor)).toContain("toc");
    });

    // Removing a node-selected TOC whose previous sibling is a decorator (here a
    // horizontal rule) collapses the range selection onto the RootNode (Lexical's
    // selectPrevious() falls back to an element point on the parent). Inserting from
    // that root anchor must still resolve a real block.
    it("re-inserts a TOC after removing a TOC next to a horizontal rule (anchor on root)", () => {
        const editor = createTestEditor();
        let tocKey = "";
        editor.update(
            () => {
                const root = $getRoot();
                root.clear();
                root.append($createHorizontalRuleNode()); // decorator previous sibling
                const toc = $createTocNode(1, 6);
                root.append(toc);
                tocKey = toc.getKey();
            },
            { discrete: true }
        );
        editor.update(
            () => {
                const selection = $createNodeSelection();
                selection.add(tocKey);
                $setSelection(selection);
                $toggleTableOfContents(); // removes it -> anchor lands on root
            },
            { discrete: true }
        );

        expect(anchorTopLevelType(editor)).toBeNull(); // anchor sits on the root

        // Inserting from a root anchor must not throw; the headless editor's onError
        // rethrows, so a throw fails the test.
        editor.update(() => $toggleTableOfContents(), { discrete: true });
        expect(rootTypes(editor)).toContain("toc");
    });

    // Removing the only block must leave a typeable paragraph, not an empty root.
    it("restores a paragraph when removing the only TOC empties the document", () => {
        const editor = createTestEditor();
        let tocKey = "";
        editor.update(
            () => {
                const root = $getRoot();
                root.clear();
                const toc = $createTocNode(1, 6);
                root.append(toc);
                tocKey = toc.getKey();
            },
            { discrete: true }
        );
        editor.update(
            () => {
                const selection = $createNodeSelection();
                selection.add(tocKey);
                $setSelection(selection);
                $toggleTableOfContents();
            },
            { discrete: true }
        );
        expect(rootTypes(editor)).toEqual(["paragraph"]);
        expect(anchorTopLevelType(editor)).toBe("paragraph"); // caret landed in it
    });

    // Same failure mode reached directly: a range-selection anchor sitting on the
    // root (no headings/TOC present, so the toggle takes the insert path).
    it("inserts a TOC when the range-selection anchor is the root node", () => {
        const editor = createTestEditor();
        editor.update(
            () => {
                const root = $getRoot();
                root.clear();
                root.append($createParagraphNode());
                const selection = $createRangeSelection();
                selection.anchor.set(root.getKey(), root.getChildrenSize(), "element");
                selection.focus.set(root.getKey(), root.getChildrenSize(), "element");
                $setSelection(selection);
                $toggleTableOfContents();
            },
            { discrete: true }
        );
        expect(rootTypes(editor)).toContain("toc");
    });
});
