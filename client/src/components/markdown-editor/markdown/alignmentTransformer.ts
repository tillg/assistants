import { $convertFromMarkdownString, type MultilineElementTransformer, type Transformer } from "@lexical/markdown";
import { $createParagraphNode, $isElementNode, type ElementFormatType, type ElementNode } from "lexical";

import { CONTAINER_DIRECTIVE_END, serializeDirectiveAttributes } from "./directives";

/**
 * Block alignment values worth storing. `left` and the unset format ("") render
 * as the default, so they emit no directive; `start`/`end` are never produced by
 * the A12 AlignButtonGroup.
 */
const STORED_ALIGNMENTS = ["center", "right", "justify"] as const;

function isStoredAlignment(value: ElementFormatType): value is (typeof STORED_ALIGNMENTS)[number] {
    return (STORED_ALIGNMENTS as readonly string[]).includes(value);
}

/**
 * Alignment values accepted on import. `left` is tolerated (a no-op reset to the
 * default) but never emitted; anything outside these four never reaches the
 * transformer (see ALIGN_START).
 */
const IMPORT_ALIGNMENTS: readonly ElementFormatType[] = ["left", "center", "right", "justify"];

function toElementFormat(value: string): ElementFormatType | null {
    return (IMPORT_ALIGNMENTS as readonly string[]).includes(value) ? (value as ElementFormatType) : null;
}

// Start line of an alignment container: `:::align{to="<value>"}`. The four valid
// values are baked into the pattern, so a malformed/unknown `to` (e.g.
// `to="middle"`) matches no transformer and survives verbatim as plain text
// (spec 009 degrade-for-free), and prose beginning `:::align` without a valid
// attribute is never mis-parsed.
const ALIGN_START = /^:::align\{to="(left|center|right|justify)"\}\s*$/;

// A directive fence line, used to keep alignment from wrapping a block whose own
// markdown is itself a `:::` container (admonition/TOC): our home-grown matcher
// does not support nesting `:::` fences, so wrapping one would produce
// un-round-trippable markdown. Such blocks serialize un-aligned instead (valid
// markdown wins over a lost format bit).
const CONTAINS_DIRECTIVE_FENCE = /^:::/m;

/**
 * Block text-alignment directive (`:::align{to="center|right|justify"}\n<block>\n:::`,
 * spec 024). Alignment is applied in the editor as a Lexical element `format` bit
 * (via the A12 AlignButtonGroup's `FORMAT_ELEMENT_COMMAND`); this
 * `MultilineElementTransformer` is the only project code — it (de)serializes that
 * bit to/from the directive. No `AlignNode` exists in the tree.
 *
 * Export delegates the inner block markdown to the other block transformers (so a
 * centered heading keeps its `#`, a centered list its `- `); import sets the
 * format bit on each parsed block so re-editing and the toolbar's active state
 * behave exactly as for editor-applied alignment. The body is (de)serialized by
 * recursively reusing the full transformer set in preserve-newlines mode (the
 * `admonitionTransformer` pattern), supplied lazily via `getTransformers` to
 * avoid importing the registry this transformer is part of.
 *
 * Placed first in the registry so it is the first *multiline* transformer tried on
 * export (@lexical/markdown tries all multiline transformers before all element
 * transformers, first non-null `export` wins) — letting it claim a format-bearing
 * block ahead of CODE/ADMONITION/TABLE.
 */
export function createAlignTransformer(getTransformers: () => Transformer[]): MultilineElementTransformer {
    const serializeInnerBlock = (node: ElementNode, traverseChildren: (node: ElementNode) => string): string => {
        for (const other of getTransformers()) {
            if (other === transformer) {
                continue; // never delegate to ourselves — would re-wrap and recurse
            }
            if ((other.type === "element" || other.type === "multiline-element") && other.export) {
                const out = other.export(node, traverseChildren);
                if (out !== null) {
                    return out;
                }
            }
        }
        // No block transformer matched (e.g. a plain paragraph): its markdown is
        // just its inline content — the same fallback $convertToMarkdownString uses.
        return traverseChildren(node);
    };

    const transformer: MultilineElementTransformer = {
        dependencies: [],
        export: (node, traverseChildren) => {
            if (!$isElementNode(node)) {
                return null;
            }
            const format = node.getFormatType();
            if (!isStoredAlignment(format)) {
                return null;
            }
            const inner = serializeInnerBlock(node, traverseChildren);
            if (CONTAINS_DIRECTIVE_FENCE.test(inner)) {
                return null; // aligned container directive — serialize un-aligned (valid markdown)
            }
            const attrs = serializeDirectiveAttributes([["to", format]]);
            return `:::align{${attrs}}\n${inner}\n:::`;
        },
        regExpStart: ALIGN_START,
        regExpEnd: { regExp: CONTAINER_DIRECTIVE_END },
        replace: (rootNode, _children, startMatch, _endMatch, linesInBetween) => {
            const format = startMatch[1] === undefined ? null : toElementFormat(startMatch[1]);
            if (format === null) {
                return false;
            }
            // linesInBetween[0] and [last] are the start/end fence-line remainders
            // (empty, both regexes consume the whole line); the body sits between.
            const bodyLines = linesInBetween ? linesInBetween.slice(1, -1) : [];
            // Transient, never-attached container: convert the body into it, then
            // move each parsed block into the tree with the alignment bit set.
            const scratch = $createParagraphNode();
            if (bodyLines.length > 0) {
                $convertFromMarkdownString(bodyLines.join("\n"), getTransformers(), scratch, true);
            } else {
                scratch.append($createParagraphNode());
            }
            for (const child of scratch.getChildren()) {
                if ($isElementNode(child)) {
                    child.setFormat(format);
                }
                rootNode.append(child);
            }
            return true;
        },
        type: "multiline-element"
    };
    return transformer;
}
