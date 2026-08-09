import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { COMMAND_PRIORITY_EDITOR } from "lexical";
import { useEffect } from "react";

import {
    INSERT_ADMONITION_COMMAND,
    INSERT_HORIZONTAL_RULE_COMMAND,
    INSERT_TABLE_OF_CONTENTS_COMMAND
} from "../commands";
import { $applyAdmonitionVariant, $insertHorizontalRule, $toggleTableOfContents } from "../insertion/blockInsertion";

/**
 * Registers the directive block-insert commands (horizontal rule, admonition panel,
 * table of contents) so every insertion surface — toolbar Insert menu, slash menu,
 * keyboard shortcuts — triggers one shared implementation.
 *
 * Lexical wraps command listeners in an editor update (`updateEditorSync`), so the
 * handlers call the `$`-prefixed ops directly rather than opening their own update.
 */
export function InsertionCommandsPlugin() {
    const [editor] = useLexicalComposerContext();

    useEffect(() => {
        const unregisterHorizontalRule = editor.registerCommand(
            INSERT_HORIZONTAL_RULE_COMMAND,
            () => {
                $insertHorizontalRule();
                return true;
            },
            COMMAND_PRIORITY_EDITOR
        );
        const unregisterAdmonition = editor.registerCommand(
            INSERT_ADMONITION_COMMAND,
            (variant) => {
                $applyAdmonitionVariant(variant);
                return true;
            },
            COMMAND_PRIORITY_EDITOR
        );
        const unregisterToc = editor.registerCommand(
            INSERT_TABLE_OF_CONTENTS_COMMAND,
            () => {
                $toggleTableOfContents();
                return true;
            },
            COMMAND_PRIORITY_EDITOR
        );
        return () => {
            unregisterHorizontalRule();
            unregisterAdmonition();
            unregisterToc();
        };
    }, [editor]);

    return null;
}
