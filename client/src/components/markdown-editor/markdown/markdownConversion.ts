import { $convertFromMarkdownString, $convertToMarkdownString } from "@lexical/markdown";
import type { ElementNode } from "lexical";

import { MARKDOWN_TRANSFORMERS } from "./markdownTransformers";

/**
 * Conversion between markdown and the Lexical editor state (spec 006).
 * Uses Lexical's preserve-newlines mode on both directions so blank lines
 * round-trip as empty paragraphs — what the user types is what persists.
 * (This is a newline-delimited markdown dialect, not strict CommonMark;
 * the editor is the sole producer/consumer of the stored content.)
 */
export function $markdownToNodes(markdown: string, node?: ElementNode): void {
    $convertFromMarkdownString(markdown, MARKDOWN_TRANSFORMERS, node, true);
}

export function $nodesToMarkdown(node?: ElementNode): string {
    return $convertToMarkdownString(MARKDOWN_TRANSFORMERS, node, true);
}
