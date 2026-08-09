import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import type { EditorState } from "lexical";
import { useCallback, useEffect, useRef } from "react";

import { $markdownToNodes, $nodesToMarkdown } from "../markdown/markdownConversion";

export interface MarkdownSyncPluginProps {
    /** Current markdown value from the form engine. */
    value: string;
    /** Called with the serialized markdown whenever the editor content changes. */
    onMarkdownChange(markdown: string): void;
}

export function MarkdownSyncPlugin({ value, onMarkdownChange }: MarkdownSyncPluginProps) {
    const [editor] = useLexicalComposerContext();
    const lastEmitted = useRef(value);

    // External value change (e.g. another document selected): re-initialize the editor.
    // Never re-init while the user is typing in the editor — the form engine may round-trip
    // a normalized value on every emission, and re-importing would destroy the in-progress
    // editor state (mirrors BufferedInput's focus-based buffering).
    useEffect(() => {
        if (value === lastEmitted.current) {
            return;
        }
        const rootElement = editor.getRootElement();
        const editorHasFocus = rootElement?.contains(document.activeElement);
        if (!editorHasFocus) {
            // Only record the value as seen once it is actually applied. Recording it while
            // focused (and skipping the re-import) would mark a genuine external change as
            // seen and lose it permanently, since the next run would early-return on equality.
            lastEmitted.current = value;
            editor.update(() => {
                $markdownToNodes(value);
            });
        }
    }, [editor, value]);

    // Stable identity so OnChangePlugin does not re-register its update listener every render.
    const handleChange = useCallback(
        (editorState: EditorState) => {
            editorState.read(() => {
                const markdown = $nodesToMarkdown();
                if (markdown !== lastEmitted.current) {
                    lastEmitted.current = markdown;
                    onMarkdownChange(markdown);
                }
            });
        },
        [onMarkdownChange]
    );

    return <OnChangePlugin ignoreSelectionChange onChange={handleChange} />;
}
