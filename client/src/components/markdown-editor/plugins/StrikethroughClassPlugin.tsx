import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";

import { InlineStyleTextNode } from "@com.mgmtp.a12.widgets/widgets-core";

const STRIKETHROUGH_CLASS = "editor-text-strikethrough";

/**
 * Workaround for an A12 widgets-core bug (observed in 38.3.x): the widget replaces
 * Lexical's TextNode with InlineStyleTextNode, whose updateDOMStyle() rebuilds the
 * DOM class list from the bold/italic/underline format bits and the custom
 * __selectedClassName styles — but never from the plain `strikethrough` format bit.
 * Struck text therefore renders with no visual change in the editing view (the
 * node's exportDOM handles strikethrough correctly; only the live view drops it).
 *
 * This transform mirrors the strikethrough format bit into the node's selected
 * style names — the channel updateDOMStyle() does render — and removes it again
 * when the format is toggled off. Markdown serialization is unaffected: the
 * STRIKETHROUGH transformer reads the format bit, and selected style names are
 * not part of the stored markdown.
 *
 * Re-verified against widgets-core 39.0.2: still unfixed — InlineStyleTextNode.updateDOMStyle() and the
 * new <s>-tag path both key off the selected-style-name channel this plugin drives, never the format bit.
 * Re-check on future widgets-core upgrades; delete once fixed upstream.
 */
export function StrikethroughClassPlugin() {
    const [editor] = useLexicalComposerContext();

    useEffect(
        () =>
            editor.registerNodeTransform(InlineStyleTextNode, (node) => {
                const hasFormat = node.hasFormat("strikethrough");
                const hasClass = node.getSelectedStyleName().includes(STRIKETHROUGH_CLASS);
                if (hasFormat && !hasClass) {
                    node.addSelectedStyleName(STRIKETHROUGH_CLASS);
                } else if (!hasFormat && hasClass) {
                    node.removeSelectedStyleName(STRIKETHROUGH_CLASS);
                }
            }),
        [editor]
    );

    return null;
}
