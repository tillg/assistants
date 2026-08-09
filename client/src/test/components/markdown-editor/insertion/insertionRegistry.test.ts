import {
    $createNodeSelection,
    $createParagraphNode,
    $createTextNode,
    $getRoot,
    $getSelection,
    $setSelection,
    type BaseSelection
} from "lexical";
import { describe, expect, it } from "vitest";

import { INSERT_EXTENSIONS, insertableItems } from "../../../../components/markdown-editor/insertion/insertionRegistry";
import { $createAdmonitionNode } from "../../../../components/markdown-editor/nodes/AdmonitionNode";
import { $createTocNode } from "../../../../components/markdown-editor/nodes/TocNode";

import { createTestEditor } from "../markdownTestUtils";

/** isActive of the given item keys, read against the editor's current selection. */
function activeStates(editor: ReturnType<typeof createTestEditor>, keys: string[]): Record<string, boolean> {
    const items = insertableItems();
    const states: Record<string, boolean> = {};
    editor.getEditorState().read(() => {
        const selection: BaseSelection | null = $getSelection();
        for (const key of keys) {
            states[key] = items.find((item) => item.key === key)!.isActive(selection);
        }
    });
    return states;
}

/**
 * The registry is the single source the toolbar Insert menu, slash menu and shortcut
 * binder all derive from — these guard its flattened contract so the surfaces stay in
 * sync (a lightweight stand-in for the full parity-audit test).
 */
describe("insertion registry", () => {
    it("flattens to one item per variant, ordered by displayOrder", () => {
        const keys = insertableItems().map((item) => item.key);
        expect(keys).toEqual([
            "table",
            "image",
            "hr",
            "admonition:info",
            "admonition:warning",
            "admonition:note",
            "admonition:tip",
            "admonition:panel",
            "toc",
            "link"
        ]);
    });

    it("gives every item a command and an insert action", () => {
        for (const item of insertableItems()) {
            expect(item.command).toBeDefined();
            expect(typeof item.insert).toBe("function");
        }
    });

    it("routes insert-only items to the Insert dropdown and toggleable + link items to slash only", () => {
        const surfaces = Object.fromEntries(insertableItems().map((item) => [item.key, item.surfaces]));
        // Insert dropdown holds the non-toggleable inserts.
        expect(
            insertableItems()
                .filter((item) => item.surfaces.insertMenu)
                .map((item) => item.key)
        ).toEqual(["table", "image", "hr"]);
        // Panels, TOC and link keep their own top-level control, so they are slash-only.
        for (const key of ["admonition:info", "toc", "link"]) {
            expect(surfaces[key]?.insertMenu).toBe(false);
            expect(surfaces[key]?.slashMenu).toBe(true);
        }
    });

    it("binds the documented shortcuts and leaves tip/panel unbound", () => {
        const shortcuts = Object.fromEntries(insertableItems().map((item) => [item.key, item.keyboardShortcut]));
        // Table uses `a`, not `t`: Ctrl+Alt+T is the Linux "open terminal" WM shortcut.
        expect(shortcuts.table).toBe("mod+alt+a");
        expect(shortcuts.toc).toBe("mod+alt+o");
        expect(shortcuts["admonition:info"]).toBe("mod+alt+i");
        expect(shortcuts["admonition:warning"]).toBe("mod+alt+w");
        expect(shortcuts["admonition:note"]).toBe("mod+alt+n");
        expect(shortcuts["admonition:tip"]).toBeUndefined();
        expect(shortcuts["admonition:panel"]).toBeUndefined();
        // Link uses the universal Ctrl/Cmd+K.
        expect(shortcuts.link).toBe("mod+k");
    });

    it("includes displayName tokens and entry keywords in each item's slash keywords", () => {
        const toc = insertableItems().find((item) => item.key === "toc");
        expect(toc?.slashKeywords).toContain("contents");
        expect(toc?.slashKeywords).toContain("table"); // from "Table of contents"
    });

    it("exposes each entry command once (no duplicate registration targets)", () => {
        const commands = new Set(INSERT_EXTENSIONS.map((entry) => entry.command));
        expect(commands.size).toBe(INSERT_EXTENSIONS.length);
    });
});

describe("insertion registry — active state (surfaces render a checkmark on the current node)", () => {
    it("marks the matching panel variant active when the caret is inside a panel", () => {
        const editor = createTestEditor();
        editor.update(
            () => {
                const root = $getRoot();
                root.clear();
                const panel = $createAdmonitionNode("info");
                const body = $createParagraphNode();
                body.append($createTextNode("inside"));
                panel.append(body);
                root.append(panel);
                body.selectEnd();
            },
            { discrete: true }
        );
        const states = activeStates(editor, ["admonition:info", "admonition:warning", "table", "toc"]);
        expect(states["admonition:info"]).toBe(true);
        expect(states["admonition:warning"]).toBe(false);
        expect(states.table).toBe(false); // insert-only items never report active
        expect(states.toc).toBe(false);
    });

    it("marks the TOC item active when the TOC is selected", () => {
        const editor = createTestEditor();
        editor.update(
            () => {
                const root = $getRoot();
                root.clear();
                const toc = $createTocNode(1, 6);
                root.append(toc);
                const selection = $createNodeSelection();
                selection.add(toc.getKey());
                $setSelection(selection);
            },
            { discrete: true }
        );
        expect(activeStates(editor, ["toc"]).toc).toBe(true);
    });
});
