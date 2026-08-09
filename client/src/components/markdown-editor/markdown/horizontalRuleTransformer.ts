import { type ElementTransformer } from "@lexical/markdown";
import { $createHorizontalRuleNode, $isHorizontalRuleNode, HorizontalRuleNode } from "@lexical/extension";

const HR_REG_EXP = /^(---|\*\*\*|___)\s?$/;

/**
 * Thematic break. @lexical/markdown ships no HR transformer (it exports
 * CHECK_LIST but not HR), so this is project-maintained — adapted from the
 * Lexical playground (v0.31.2). Imports a whole line of ---, ***, or ___;
 * always exports ---.
 */
export const HR: ElementTransformer = {
    dependencies: [HorizontalRuleNode],
    export: (node) => ($isHorizontalRuleNode(node) ? "---" : null),
    regExp: HR_REG_EXP,
    replace: (parentNode, _children, _match, isImport) => {
        const line = $createHorizontalRuleNode();
        // On import (or mid-document) replace the matched paragraph; when typed at
        // the end of the document, insert before so the trailing paragraph survives.
        if (isImport || parentNode.getNextSibling() !== null) {
            parentNode.replace(line);
        } else {
            parentNode.insertBefore(line);
        }
        line.selectNext();
    },
    type: "element"
};
