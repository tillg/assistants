import { useCallback, useContext, type ChangeEvent } from "react";

import { DefaultWidgetMap } from "@com.mgmtp.a12.formengine/formengine-core";
import type { TextAreaStatelessProps } from "@com.mgmtp.a12.widgets/widgets-core";

import { ModelElementContext } from "../../ModelElementBridge";
import { hasWidgetAnnotation } from "../../widgetAnnotation";

import { MarkdownRichTextEditor } from "../editor/MarkdownRichTextEditor";

/**
 * widgetMap.TextAreaStateless replacement: renders the markdown editor for controls
 * annotated `widget: markdown-editor`, the default text area otherwise.
 *
 * Mounted inside the form engine's BufferedInput(HTMLInputAdapter(...)) wrapper —
 * changes are reported through onChange with a { target: { value } }-shaped event,
 * which the adapter translates into form-engine state updates.
 */
export function MarkdownTextArea(props: TextAreaStatelessProps) {
    const control = useContext(ModelElementContext);
    const { value, onChange, inputRef, onBlur, ...rest } = props;

    // Stable identity so the editor's OnChangePlugin doesn't re-register its listener each render.
    const handleMarkdownChange = useCallback(
        (markdown: string) => onChange?.({ target: { value: markdown } } as ChangeEvent<HTMLTextAreaElement>),
        [onChange]
    );

    if (!hasWidgetAnnotation(control?.annotations, "markdown-editor")) {
        return <DefaultWidgetMap.TextAreaStateless {...props} />;
    }

    return (
        <MarkdownRichTextEditor
            id={rest.id}
            label={rest.label}
            hideLabel={rest.hideLabel}
            readonly={rest.readonly}
            disabled={rest.disabled}
            error={rest.error}
            warning={rest.warning}
            info={rest.info}
            errorMessage={rest.errorMessage}
            warningMessage={rest.warningMessage}
            infoMessage={rest.infoMessage}
            helperText={rest.helperText}
            placeholder={rest.placeholder}
            value={typeof value === "string" ? value : ""}
            inputRef={inputRef}
            onBlur={onBlur}
            onMarkdownChange={handleMarkdownChange}
        />
    );
}
