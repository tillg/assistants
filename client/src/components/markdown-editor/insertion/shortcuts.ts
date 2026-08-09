/**
 * Mousetrap-style keyboard-shortcut parsing/matching/formatting for the insertion
 * registry (e.g. `"mod+alt+t"`). `mod` resolves to Cmd on macOS and Ctrl elsewhere.
 * Matching is done against `event.code` (physical key) so it survives the alt-graph
 * remapping Option/Alt applies to `event.key` on some layouts.
 */

export interface ParsedShortcut {
    ctrl: boolean;
    meta: boolean;
    alt: boolean;
    shift: boolean;
    /** Physical key code, e.g. `"KeyT"`. */
    code: string;
}

/** Fields of a KeyboardEvent the matcher needs (kept minimal so tests can pass a plain object). */
export type ShortcutEvent = Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "code">;

export function isMacPlatform(): boolean {
    if (typeof navigator === "undefined") {
        return false;
    }
    return /mac|ip(hone|ad|od)/i.test(navigator.platform || navigator.userAgent);
}

/** `"t"` → `"KeyT"`, `"1"` → `"Digit1"`; otherwise the token verbatim (rare non-alphanumeric keys). */
function keyToCode(key: string): string {
    if (/^[a-z]$/.test(key)) {
        return `Key${key.toUpperCase()}`;
    }
    if (/^[0-9]$/.test(key)) {
        return `Digit${key}`;
    }
    return key;
}

export function parseShortcut(spec: string, isMac: boolean): ParsedShortcut {
    const parsed: ParsedShortcut = { ctrl: false, meta: false, alt: false, shift: false, code: "" };
    for (const rawPart of spec.toLowerCase().split("+")) {
        const part = rawPart.trim();
        if (part === "mod") {
            if (isMac) {
                parsed.meta = true;
            } else {
                parsed.ctrl = true;
            }
        } else if (part === "ctrl" || part === "control") {
            parsed.ctrl = true;
        } else if (part === "meta" || part === "cmd" || part === "command") {
            parsed.meta = true;
        } else if (part === "alt" || part === "option") {
            parsed.alt = true;
        } else if (part === "shift") {
            parsed.shift = true;
        } else if (part !== "") {
            parsed.code = keyToCode(part);
        }
    }
    return parsed;
}

export function matchesShortcut(shortcut: ParsedShortcut, event: ShortcutEvent): boolean {
    return (
        event.code === shortcut.code &&
        event.ctrlKey === shortcut.ctrl &&
        event.metaKey === shortcut.meta &&
        event.altKey === shortcut.alt &&
        event.shiftKey === shortcut.shift
    );
}

/** Human-readable label: `"⌘⌥T"` on macOS, `"Ctrl+Alt+T"` elsewhere. */
export function formatShortcut(spec: string, isMac: boolean): string {
    const symbols = spec
        .toLowerCase()
        .split("+")
        .map((rawPart) => {
            const part = rawPart.trim();
            switch (part) {
                case "mod":
                    return isMac ? "⌘" : "Ctrl";
                case "ctrl":
                case "control":
                    return isMac ? "⌃" : "Ctrl";
                case "meta":
                case "cmd":
                case "command":
                    return isMac ? "⌘" : "Win";
                case "alt":
                case "option":
                    return isMac ? "⌥" : "Alt";
                case "shift":
                    return isMac ? "⇧" : "Shift";
                default:
                    return part.toUpperCase();
            }
        });
    return isMac ? symbols.join("") : symbols.join("+");
}

/** `"Table"` + `"mod+alt+t"` → `"Table (Ctrl+Alt+T)"`; label unchanged when there is no shortcut. */
export function withShortcut(label: string, spec: string | undefined, isMac: boolean): string {
    return spec === undefined ? label : `${label} (${formatShortcut(spec, isMac)})`;
}
