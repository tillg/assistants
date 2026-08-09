import { describe, expect, it } from "vitest";

import {
    formatShortcut,
    matchesShortcut,
    parseShortcut,
    withShortcut,
    type ShortcutEvent
} from "../../../../components/markdown-editor/insertion/shortcuts";

function keyEvent(overrides: Partial<ShortcutEvent>): ShortcutEvent {
    return { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, code: "", ...overrides };
}

describe("shortcut parsing / matching", () => {
    it("resolves `mod` to Ctrl off macOS and Cmd on macOS, and keys to physical codes", () => {
        expect(parseShortcut("mod+alt+t", false)).toEqual({
            ctrl: true,
            meta: false,
            alt: true,
            shift: false,
            code: "KeyT"
        });
        expect(parseShortcut("mod+alt+t", true)).toEqual({
            ctrl: false,
            meta: true,
            alt: true,
            shift: false,
            code: "KeyT"
        });
    });

    it("matches on physical code, ignoring the alt-graph character on `event.key`", () => {
        const parsed = parseShortcut("mod+alt+t", false);
        // Linux: Ctrl+Alt physically pressing the T key — event.code is stable even if event.key isn't.
        expect(matchesShortcut(parsed, keyEvent({ ctrlKey: true, altKey: true, code: "KeyT" }))).toBe(true);
        // Missing Alt, or an extra modifier, must not match.
        expect(matchesShortcut(parsed, keyEvent({ ctrlKey: true, code: "KeyT" }))).toBe(false);
        expect(matchesShortcut(parsed, keyEvent({ ctrlKey: true, altKey: true, shiftKey: true, code: "KeyT" }))).toBe(
            false
        );
        // Cmd instead of Ctrl (wrong platform modifier) must not match.
        expect(matchesShortcut(parsed, keyEvent({ metaKey: true, altKey: true, code: "KeyT" }))).toBe(false);
    });

    it("formats for display per platform", () => {
        expect(formatShortcut("mod+alt+t", false)).toBe("Ctrl+Alt+T");
        expect(formatShortcut("mod+alt+t", true)).toBe("⌘⌥T");
        expect(formatShortcut("mod+alt+i", true)).toBe("⌘⌥I");
    });

    it("appends the formatted shortcut to a label, or leaves it untouched when absent", () => {
        expect(withShortcut("Table", "mod+alt+t", false)).toBe("Table (Ctrl+Alt+T)");
        expect(withShortcut("Image", undefined, false)).toBe("Image");
    });
});
