import { CheckListPlugin } from "@lexical/react/LexicalCheckListPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { TablePlugin } from "@lexical/react/LexicalTablePlugin";
import { useMemo, useRef } from "react";

import { DefaultRichTextEditor } from "@com.mgmtp.a12.widgets/widgets-core";

import { useLocalizer } from "../../../localization";

import { $markdownToNodes } from "../markdown/markdownConversion";
import { MARKDOWN_NODES, MARKDOWN_TRANSFORMERS } from "../markdown/markdownTransformers";
import { AdmonitionEmptyGuardPlugin } from "../plugins/AdmonitionEmptyGuardPlugin";
import { BlockMarkdownEnterPlugin } from "../plugins/BlockMarkdownEnterPlugin";
import { BufferedFocusBridgePlugin } from "../plugins/BufferedFocusBridgePlugin";
import { ColorDialogPlugin } from "../plugins/ColorDialogPlugin";
import { EdgeClickParagraphPlugin } from "../plugins/EdgeClickParagraphPlugin";
import { ImageDialogPlugin } from "../plugins/ImageDialogPlugin";
import { InsertionCommandsPlugin } from "../plugins/InsertionCommandsPlugin";
import { LinkDialogPlugin } from "../plugins/LinkDialogPlugin";
import { MarkdownSyncPlugin } from "../plugins/MarkdownSyncPlugin";
import { ShortcutsPlugin } from "../plugins/ShortcutsPlugin";
import { SlashCommandPlugin } from "../plugins/SlashCommandPlugin";
import { StrikethroughClassPlugin } from "../plugins/StrikethroughClassPlugin";
import { MARKDOWN_EDITOR_THEME } from "../theme/editorTheme";
import { buildMarkdownToolbarButtons } from "../toolbar/toolbarButtons";

import { markdownEditorOnError } from "./markdownEditorOnError";
import { useLinkPluginConfig } from "./useLinkPluginConfig";
import type { MarkdownRichTextEditorProps } from "./markdownRichTextEditorProps";

export interface VisualEditorProps {
    value: string;
    onMarkdownChange(markdown: string): void;
    inputProps: Omit<MarkdownRichTextEditorProps, "value" | "onMarkdownChange" | "inputRef" | "onBlur">;
    inputRef?: MarkdownRichTextEditorProps["inputRef"];
    onBlur?: MarkdownRichTextEditorProps["onBlur"];
}

/**
 * The visual editor: wraps `DefaultRichTextEditor` and owns its own composer.
 *
 * Extracted so that the Visual/Markdown branch fully unmounts and remounts it: each return to Visual mode
 * mounts a fresh instance (and thus a fresh initialValue ref and initialConfig) that re-initialises from
 * the current markdown value. That remount *is* the mechanism by which source edits reach the visual
 * editor.
 */
export function VisualEditor({ value, onMarkdownChange, inputProps, inputRef, onBlur }: VisualEditorProps) {
    const localize = useLocalizer();
    const toolbarButtons = useMemo(() => buildMarkdownToolbarButtons(localize), [localize]);

    // Capture the mount-time value: initialConfig.editorState runs exactly once.
    // Later external changes are handled by MarkdownSyncPlugin.
    const initialValue = useRef(value);
    const initialConfig = useMemo(
        () => ({
            nodes: MARKDOWN_NODES,
            // Deep-merged into (extends, not replaces) the widget's default editorThemeClasses.
            theme: MARKDOWN_EDITOR_THEME,
            editorState: () => $markdownToNodes(initialValue.current),
            // Replaces the widget's default rethrow-all handler (see the handler's doc comment).
            onError: markdownEditorOnError
        }),
        []
    );

    const linkPluginConfig = useLinkPluginConfig();

    return (
        <DefaultRichTextEditor
            {...inputProps}
            initialConfig={initialConfig}
            staticToolbarButtons={toolbarButtons}
            linkPluginConfig={linkPluginConfig}
            autoExpand
            minHeight={160}>
            <MarkdownSyncPlugin value={value} onMarkdownChange={onMarkdownChange} />
            <BufferedFocusBridgePlugin inputRef={inputRef} onBlur={onBlur} />
            <MarkdownShortcutPlugin transformers={MARKDOWN_TRANSFORMERS} />
            <TablePlugin />
            <CheckListPlugin />
            <InsertionCommandsPlugin />
            <ShortcutsPlugin />
            <SlashCommandPlugin />
            <LinkDialogPlugin />
            <ImageDialogPlugin />
            <ColorDialogPlugin />
            <StrikethroughClassPlugin />
            <BlockMarkdownEnterPlugin />
            <EdgeClickParagraphPlugin />
            <AdmonitionEmptyGuardPlugin />
        </DefaultRichTextEditor>
    );
}
