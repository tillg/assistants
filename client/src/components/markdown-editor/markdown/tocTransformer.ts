import { type MultilineElementTransformer } from "@lexical/markdown";

import {
    $createTocNode,
    $isTocNode,
    clampTocLevel,
    TOC_MAX_LEVEL_DEFAULT,
    TOC_MIN_LEVEL_DEFAULT,
    TocNode
} from "../nodes/TocNode";

import { CONTAINER_DIRECTIVE_END, parseDirectiveAttributes, serializeDirectiveAttributes } from "./directives";

// Start line of a TOC: `:::toc{minLevel="…" maxLevel="…"}` (attrs optional).
const TOC_START = /^:::toc(?:\{([^}]*)\})?\s*$/;

/**
 * Table-of-contents leaf directive (`:::toc{minLevel="1" maxLevel="6"}\n:::`,
 * spec 009). Built as a Lexical `MultilineElementTransformer`. The body is
 * always empty — the rendered list is a live view (see {@link TocNode}) — so any
 * incoming body is discarded and `export` emits an empty body, keeping cycle-2
 * byte-identity.
 */
export const TOC: MultilineElementTransformer = {
    dependencies: [TocNode],
    export: (node) => {
        if (!$isTocNode(node)) {
            return null;
        }
        const attrs = serializeDirectiveAttributes([
            ["minLevel", String(node.getMinLevel())],
            ["maxLevel", String(node.getMaxLevel())]
        ]);
        return `:::toc{${attrs}}\n:::`;
    },
    regExpStart: TOC_START,
    regExpEnd: { regExp: CONTAINER_DIRECTIVE_END },
    replace: (rootNode, _children, startMatch) => {
        const attrs = parseDirectiveAttributes(startMatch[1]);
        const minLevel = clampTocLevel(attrs.minLevel, TOC_MIN_LEVEL_DEFAULT);
        const maxLevel = clampTocLevel(attrs.maxLevel, TOC_MAX_LEVEL_DEFAULT);
        rootNode.append($createTocNode(minLevel, maxLevel));
    },
    type: "multiline-element"
};
