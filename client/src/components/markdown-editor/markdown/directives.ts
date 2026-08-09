/**
 * Shared helpers for the remark-directive dialect (`:::name{attrs} … :::`,
 * spec 009). Directive features are built as Lexical `MultilineElementTransformer`s
 * (no remark dependency); these helpers keep the admonition and TOC transformers
 * DRY.
 *
 * Unknown directives need no fallback rule here: each transformer's start-regex
 * is name-specific (`:::admonition` / `:::toc`), so any other `:::name` line
 * matches no transformer and survives verbatim as plain text. We also do not
 * escape/unescape colons — our pipeline has no greedy directive tokenizer, so
 * prose like `16:00` round-trips uncorrupted (unlike w12-free's remark pipeline,
 * which must escape `\:`).
 */

/** Closing fence of a container directive. Tolerant of leading whitespace so the
 * indented `  :::` that remark-stringify emits after a trailing list still closes
 * the block (it canonicalizes to a column-0 `:::` on our re-export). */
export const CONTAINER_DIRECTIVE_END = /^\s*:::\s*$/;

/**
 * Parse a directive attribute string (`key="value" key2="value2"`) into a map.
 * Only the quoted form is recognized — the only form our directives emit and the
 * w12-free fixtures use; anything else is ignored (the caller falls back to
 * defaults). Returns an empty map for an empty/undefined input.
 */
export function parseDirectiveAttributes(attrString: string | undefined): Record<string, string> {
    const attrs: Record<string, string> = {};
    if (!attrString) {
        return attrs;
    }
    const pairRegExp = /([A-Za-z_][\w-]*)="([^"]*)"/g;
    let match: RegExpExecArray | null;
    while ((match = pairRegExp.exec(attrString)) !== null) {
        const [, key, value] = match;
        if (key !== undefined && value !== undefined) {
            attrs[key] = value;
        }
    }
    return attrs;
}

/** Serialize ordered key/value pairs as `key="value" key2="value2"`. */
export function serializeDirectiveAttributes(pairs: readonly (readonly [string, string])[]): string {
    return pairs.map(([key, value]) => `${key}="${value}"`).join(" ");
}
