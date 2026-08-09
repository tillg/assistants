import { describe, expect, it } from "vitest";

import { FORMAT_SHORTCUTS, formatShortcutFor } from "../../../../components/markdown-editor/insertion/formatShortcuts";

describe("inline format shortcuts", () => {
    it("binds strikethrough to mod+s with a run action", () => {
        const strikethrough = FORMAT_SHORTCUTS.find((shortcut) => shortcut.key === "strikethrough");
        expect(strikethrough?.keyboardShortcut).toBe("mod+s");
        expect(typeof strikethrough?.run).toBe("function");
    });

    it("looks up a format shortcut spec by key", () => {
        expect(formatShortcutFor("strikethrough")).toBe("mod+s");
        expect(formatShortcutFor("nonexistent")).toBeUndefined();
    });
});
