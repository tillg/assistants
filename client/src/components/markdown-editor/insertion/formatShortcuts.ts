import { FORMAT_TEXT_COMMAND, type LexicalEditor } from "lexical";

/**
 * Inline text-format keyboard shortcuts the browser does NOT emit natively. Bold, italic
 * and underline fire `format*` input events on Ctrl/Cmd+B/I/U and need no binding; other
 * inline formats (strikethrough) have no such key, so we bind them here. Bound by
 * {@link ShortcutsPlugin} on the editor root and surfaced in the toolbar tooltips.
 *
 * Note: `mod+s` overrides the browser's "save page" while the editor is focused — that
 * combo is browser-level, so `preventDefault()` reliably suppresses it (unlike OS/WM
 * global combos such as `Ctrl+Alt+T`).
 */
export interface FormatShortcut {
    key: string;
    label: string;
    keyboardShortcut: string;
    run(editor: LexicalEditor): void;
}

export const FORMAT_SHORTCUTS: readonly FormatShortcut[] = [
    {
        key: "strikethrough",
        label: "Strikethrough",
        keyboardShortcut: "mod+s",
        run: (editor) => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "strikethrough")
    }
];

/** The shortcut spec for a format key, or undefined — used to label the matching toolbar button. */
export function formatShortcutFor(key: string): string | undefined {
    return FORMAT_SHORTCUTS.find((shortcut) => shortcut.key === key)?.keyboardShortcut;
}
