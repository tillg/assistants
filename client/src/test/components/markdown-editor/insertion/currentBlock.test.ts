import { $createListItemNode, $createListNode } from "@lexical/list";
import { $createHeadingNode, $createQuoteNode, $isHeadingNode, $isQuoteNode } from "@lexical/rich-text";
import { $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isParagraphNode } from "lexical";
import { describe, expect, it } from "vitest";

import { $currentBlock } from "../../../../components/markdown-editor/insertion/blockInsertion";
import { $isListActive, LIST_ITEMS } from "../../../../components/markdown-editor/insertion/listItems";
import { $createAdmonitionNode } from "../../../../components/markdown-editor/nodes/AdmonitionNode";

import { createTestEditor } from "../markdownTestUtils";

const BULLET = LIST_ITEMS.find((def) => def.listType === "bullet")!;

describe("$currentBlock resolves the block relative to its container", () => {
    it("resolves a heading at document root", () => {
        const editor = createTestEditor();
        editor.update(
            () => {
                const root = $getRoot();
                root.clear();
                const heading = $createHeadingNode("h2");
                heading.append($createTextNode("Title"));
                root.append(heading);
                heading.selectEnd();
            },
            { discrete: true }
        );
        editor.getEditorState().read(() => {
            expect($isHeadingNode($currentBlock($getSelection()))).toBe(true);
        });
    });

    it("resolves a heading nested in a panel (not the panel) — the reported bug", () => {
        const editor = createTestEditor();
        editor.update(
            () => {
                const root = $getRoot();
                root.clear();
                const panel = $createAdmonitionNode("info");
                const heading = $createHeadingNode("h2");
                heading.append($createTextNode("Title"));
                panel.append(heading);
                root.append(panel);
                heading.selectEnd();
            },
            { discrete: true }
        );
        editor.getEditorState().read(() => {
            expect($isHeadingNode($currentBlock($getSelection()))).toBe(true);
        });
    });

    it("resolves a paragraph nested in a panel", () => {
        const editor = createTestEditor();
        editor.update(
            () => {
                const root = $getRoot();
                root.clear();
                const panel = $createAdmonitionNode("info");
                const paragraph = $createParagraphNode();
                paragraph.append($createTextNode("Body"));
                panel.append(paragraph);
                root.append(panel);
                paragraph.selectEnd();
            },
            { discrete: true }
        );
        editor.getEditorState().read(() => {
            expect($isParagraphNode($currentBlock($getSelection()))).toBe(true);
        });
    });

    it("resolves a quote nested in a panel", () => {
        const editor = createTestEditor();
        editor.update(
            () => {
                const root = $getRoot();
                root.clear();
                const panel = $createAdmonitionNode("info");
                const quote = $createQuoteNode();
                quote.append($createTextNode("Quoted"));
                panel.append(quote);
                root.append(panel);
                quote.selectEnd();
            },
            { discrete: true }
        );
        editor.getEditorState().read(() => {
            expect($isQuoteNode($currentBlock($getSelection()))).toBe(true);
        });
    });

    it("detects a list nested in a panel (resolves to the ListNode, not the ListItemNode)", () => {
        const editor = createTestEditor();
        editor.update(
            () => {
                const root = $getRoot();
                root.clear();
                const panel = $createAdmonitionNode("info");
                const list = $createListNode("bullet");
                const item = $createListItemNode();
                item.append($createTextNode("item"));
                list.append(item);
                panel.append(list);
                root.append(panel);
                item.selectEnd();
            },
            { discrete: true }
        );
        editor.getEditorState().read(() => {
            expect($isListActive(BULLET, $getSelection())).toBe(true);
        });
    });
});
