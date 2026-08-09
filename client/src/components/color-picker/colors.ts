import colorNames from "color-name";

/**
 * The standard CSS named colours, sourced from the `color-name` package (name → RGB tuple) rather than
 * hand-maintained. The closed set a colour value may be, alongside a hex literal. Shared by the
 * Markdown-editor `:color` directive validation and the tag colour picker. The package omits the
 * `transparent` keyword (no RGB) — fine, invisible colour is not a useful target.
 */
export const CSS_COLOR_NAMES: ReadonlySet<string> = new Set(Object.keys(colorNames));

/** A CSS hex colour literal — 3- or 6-digit (`#f00` / `#ff0000`). */
const HEX_COLOR = /^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})$/;

/** A 6-digit `#rrggbb` literal only — the shape the colour *fields* of a document model accept. */
const SIX_DIGIT_HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

/** True for a 3- or 6-digit `#hex` string (trimmed, case-insensitive). */
export function isValidHexColor(value: string): boolean {
    return HEX_COLOR.test(value.trim());
}

/**
 * True only for a 6-digit `#rrggbb` string (trimmed, case-insensitive) — the stricter form the colour fields of
 * `TicketStatus_DM` require (`maxLength: 7` plus a `^#[0-9a-fA-F]{6}$` rule). Use this, not
 * {@link isValidColor}, wherever the picked value is written into such a field: the wider set (CSS colour names,
 * 3-digit hex) would only be rejected later, as a validation error on save.
 */
export function isSixDigitHexColor(value: string): boolean {
    return SIX_DIGIT_HEX_COLOR.test(value.trim());
}

/** True for a hex literal or a standard CSS colour name (trimmed, case-insensitive). */
export function isValidColor(value: string): boolean {
    const normalized = value.trim().toLowerCase();
    return isValidHexColor(normalized) || CSS_COLOR_NAMES.has(normalized);
}

/** Preset swatches for the simple picker — a small readable palette. */
export const PRESET_COLORS = ["#e03131", "#e8590c", "#f59f00", "#2f9e44", "#1971c2", "#9c36b5", "#1e1e1e"];

export const DEFAULT_COLOR = "#1971c2";
