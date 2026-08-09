import { useState } from "react";
import styled from "styled-components";

import { Button, ButtonGroup } from "@com.mgmtp.a12.widgets/widgets-core";

import { RESOURCE_KEYS, useLocalizer } from "../../../localization";

import { MarkdownSourceArea } from "./MarkdownSourceArea";
import { VisualEditor } from "./VisualEditor";
import type { MarkdownRichTextEditorProps } from "./markdownRichTextEditorProps";

export type { MarkdownRichTextEditorProps };

type EditorMode = "visual" | "markdown";

/** Right-aligned bar holding the Visual | Markdown segmented control (edit mode only). */
const ToggleBar = styled.div`
    display: flex;
    justify-content: flex-end;
    margin-bottom: 4px;
`;

/**
 * Shared WYSIWYG editor that persists markdown.
 * Model-agnostic: reusable for any String field via the `widget: markdown-editor` FM annotation.
 *
 * A "Visual | Markdown" segmented control is shown above the editor in edit mode only (hidden when
 * readonly or disabled). Switching to Markdown unmounts the visual editor; returning to Visual mounts a
 * fresh instance that re-parses the current markdown — that remount is how source edits reach the visual
 * editor.
 */
export function MarkdownRichTextEditor({
    value,
    onMarkdownChange,
    inputRef,
    onBlur,
    ...inputProps
}: MarkdownRichTextEditorProps) {
    const [mode, setMode] = useState<EditorMode>("visual");
    const localize = useLocalizer();

    const showSource = mode === "markdown";
    const showToggle = !inputProps.readonly && !inputProps.disabled;

    return (
        <div>
            {showToggle && (
                <ToggleBar>
                    <ButtonGroup alignment="right">
                        <Button
                            label={localize(RESOURCE_KEYS.markdownEditor.mode.visual)}
                            active={mode === "visual"}
                            onClick={() => setMode("visual")}
                        />
                        <Button
                            label={localize(RESOURCE_KEYS.markdownEditor.mode.markdown)}
                            active={showSource}
                            onClick={() => setMode("markdown")}
                        />
                    </ButtonGroup>
                </ToggleBar>
            )}
            {showSource ? (
                <MarkdownSourceArea
                    {...inputProps}
                    value={value}
                    onMarkdownChange={onMarkdownChange}
                    inputRef={inputRef}
                    onBlur={onBlur}
                />
            ) : (
                <VisualEditor
                    value={value}
                    onMarkdownChange={onMarkdownChange}
                    inputProps={inputProps}
                    inputRef={inputRef}
                    onBlur={onBlur}
                />
            )}
        </div>
    );
}
