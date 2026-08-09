import { LoggerFactory } from "@com.mgmtp.a12.utils/utils-logging";

const logger = LoggerFactory.getLogger("PT/MarkdownRichTextEditor");

/**
 * Editor-level error handler (`initialConfig.onError`; replaces the widget
 * default, which rethrows everything).
 *
 * Swallows one known benign race in @lexical/markdown (present in 0.31.2 and
 * still unfixed upstream as of 2026-06): `registerMarkdownShortcuts`' update
 * listener captures the selection's text node from the committed state and
 * uses it inside a queued `editor.update`. When the A12 auto-link plugin
 * replaces that node in between (typing a bare URL like "geta12.com"),
 * `node.getLatest()` throws "Lexical node does not exist in active editor
 * state" (prod builds: "Minified Lexical error #113"). Not rethrowing lets
 * Lexical recover by rolling back only the failed batch — which was a no-op
 * anyway: the node the shortcut runner wanted to inspect no longer exists.
 * The auto-link result and all typed text survive (smoke-verified).
 *
 * Everything else is rethrown, preserving the widget's default behavior.
 * Re-verified against Lexical 0.44.0: the registerMarkdownShortcuts race, the dev-mode message, and the
 * prod "Minified Lexical error #113" code are all unchanged — re-check on future Lexical upgrades.
 */
export function markdownEditorOnError(error: Error): void {
    const isStaleNodeRace =
        error.message.includes("Lexical node does not exist in active editor state") ||
        error.message.includes("Minified Lexical error #113");
    if (isStaleNodeRace) {
        logger.warn("Ignored stale-node race between markdown shortcuts and auto-link.", error);
        return;
    }
    throw error;
}
