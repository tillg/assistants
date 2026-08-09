import { type TextMatchTransformer } from "@lexical/markdown";

import { $createImageNode, $isImageNode, ImageNode } from "../nodes/ImageNode";

/** ![alt](src) — adapted from the Lexical playground (v0.31.2). */
export const IMAGE: TextMatchTransformer = {
    dependencies: [ImageNode],
    export: (node) => {
        if (!$isImageNode(node)) {
            return null;
        }
        return `![${node.getAltText()}](${node.getSrc()})`;
    },
    // src allows single-level balanced parens so URLs like `.../Cat_(animal).png` parse,
    // and stops at the first unbalanced `)` instead of over-capturing past it.
    importRegExp: /!(?:\[([^[]*)\])(?:\(((?:[^()]|\([^()]*\))+)\))/,
    regExp: /!(?:\[([^[]*)\])(?:\(((?:[^()]|\([^()]*\))+)\))$/,
    replace: (textNode, match) => {
        const [, altText, src] = match;
        if (altText === undefined || src === undefined) {
            return;
        }
        textNode.replace($createImageNode({ altText, src }));
    },
    trigger: ")",
    type: "text-match"
};
