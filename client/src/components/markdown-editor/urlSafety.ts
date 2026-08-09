/**
 * Render-layer guard against XSS / data-exfiltration URL schemes (spec 008).
 *
 * We block rather than allowlist, so legitimate relative and uncommon-but-safe
 * URLs still render; only `javascript:` and `data:` are refused (w12-free's
 * `sanitizeUrls` model). The stored markdown is never rewritten — this only
 * affects what the DOM projects.
 *
 * Body links are already covered by core `@lexical/link` (`LinkNode.createDOM`
 * rewrites unsupported protocols to `about:blank`); this helper backs the paths
 * core does not touch — our custom `ImageNode` src and the follow-link popup.
 */
const BLOCKED_SCHEME = /^(javascript|data):/;

export function isBlockedUrl(url: string): boolean {
    // Browsers ignore leading/embedded ASCII control and space characters when
    // resolving a scheme (e.g. `java\tscript:` or a leading newline), so drop
    // every char at or below 0x20 before testing the scheme.
    const normalized = Array.from(url)
        .filter((char) => char.charCodeAt(0) > 0x20)
        .join("")
        .toLowerCase();
    return BLOCKED_SCHEME.test(normalized);
}
