import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useEffect } from "react";

import { FORMAT_SHORTCUTS } from "../insertion/formatShortcuts";
import { isMacPlatform, matchesShortcut, parseShortcut } from "../insertion/shortcuts";
import { slashOptions } from "../insertion/slashItems";

/**
 * Binds every slash-palette option that declares a keyboard shortcut (registry
 * insertables + core block items like the lists) to its action. The listener lives
 * on the editor's root element (via `registerRootListener`), not the document, so
 * shortcuts only fire while the editor has focus.
 *
 * Note: this cannot reclaim OS/window-manager global combos — on Linux/Windows
 * `mod+alt+<letter>` maps to `Ctrl+Alt+<letter>`, some of which the WM grabs before
 * the browser ever sees the event (`event.preventDefault()` has no effect on those).
 */
export function ShortcutsPlugin() {
    const [editor] = useLexicalComposerContext();

    useEffect(() => {
        const isMac = isMacPlatform();
        const bindings = [
            // Block insertables + core block items (registry-driven, shown in the slash palette).
            ...slashOptions()
                .filter((option) => option.shortcut !== undefined)
                .map((option) => ({ shortcut: parseShortcut(option.shortcut!, isMac), run: option.run })),
            // Inline text formats with no native browser key (e.g. strikethrough).
            ...FORMAT_SHORTCUTS.map((format) => ({
                shortcut: parseShortcut(format.keyboardShortcut, isMac),
                run: format.run
            }))
        ];

        const handleKeyDown = (event: KeyboardEvent): void => {
            if (!editor.isEditable()) {
                return;
            }
            const binding = bindings.find((candidate) => matchesShortcut(candidate.shortcut, event));
            if (binding !== undefined) {
                event.preventDefault();
                editor.update(() => binding.run(editor));
            }
        };

        const removeRootListener = editor.registerRootListener((rootElement, prevRootElement) => {
            prevRootElement?.removeEventListener("keydown", handleKeyDown);
            rootElement?.addEventListener("keydown", handleKeyDown);
        });
        return () => {
            removeRootListener();
            editor.getRootElement()?.removeEventListener("keydown", handleKeyDown);
        };
    }, [editor]);

    return null;
}
