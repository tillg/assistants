import {
    $convertFromMarkdownString,
    $convertToMarkdownString,
    type MultilineElementTransformer,
    type Transformer
} from "@lexical/markdown";
import { $createParagraphNode } from "lexical";

import { $createAdmonitionNode, $isAdmonitionNode, AdmonitionNode } from "../nodes/AdmonitionNode";

import { CONTAINER_DIRECTIVE_END, parseDirectiveAttributes, serializeDirectiveAttributes } from "./directives";

// Start line of an admonition container: `:::admonition{type="…"}` (attrs optional).
// Name-specific so any other `:::name` survives as plain text (spec 009).
const ADMONITION_START = /^:::admonition(?:\{([^}]*)\})?\s*$/;

// A body line that is itself a `:::` container fence — a nested panel, or a bare `:::` the User
// typed. Our home-grown matcher does not nest `:::`, so wrapping such a body would truncate it on
// re-import at the first inner fence and spill the real closing `:::` into the document. The
// alignment transformer guards the same way.
const CONTAINS_DIRECTIVE_FENCE = /^:::/m;

/**
 * Admonition panel container directive (`:::admonition{type="…"}\n<body>\n:::`,
 * spec 009). Built as a Lexical `MultilineElementTransformer` (no remark
 * dependency). Body blocks are (de)serialized by recursively reusing the full
 * transformer set in preserve-newlines mode (the `tableTransformer` cell
 * pattern) — supplied lazily via `getTransformers` to avoid importing the
 * registry this transformer is part of.
 */
export function createAdmonitionTransformer(getTransformers: () => Transformer[]): MultilineElementTransformer {
    return {
        dependencies: [AdmonitionNode],
        export: (node) => {
            if (!$isAdmonitionNode(node)) {
                return null;
            }
            const attrs = serializeDirectiveAttributes([["type", node.getAdmonitionType()]]);
            // Preserve-newlines mode mirrors the editor's main conversion so blank
            // lines inside the body round-trip (see markdownConversion.ts).
            const body = $convertToMarkdownString(getTransformers(), node, true);
            if (CONTAINS_DIRECTIVE_FENCE.test(body)) {
                // Serialize the body un-wrapped (the panel is lost, the content is not), rather than
                // emit a container our own parser would truncate on the next read.
                return null;
            }
            return `:::admonition{${attrs}}\n${body}\n:::`;
        },
        regExpStart: ADMONITION_START,
        regExpEnd: { regExp: CONTAINER_DIRECTIVE_END },
        replace: (rootNode, _children, startMatch, _endMatch, linesInBetween) => {
            const type = parseDirectiveAttributes(startMatch[1]).type ?? "info";
            const admonition = $createAdmonitionNode(type);
            // linesInBetween[0] and [last] are always the start/end fence-line
            // remainders (empty, since both regexes consume the whole line); the
            // real body sits between them.
            const bodyLines = linesInBetween ? linesInBetween.slice(1, -1) : [];
            if (bodyLines.length > 0) {
                $convertFromMarkdownString(bodyLines.join("\n"), getTransformers(), admonition, true);
            } else {
                admonition.append($createParagraphNode());
            }
            rootNode.append(admonition);
        },
        type: "multiline-element"
    };
}
