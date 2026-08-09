import type { RichTextEditorProps, TextAreaStatelessProps } from "@com.mgmtp.a12.widgets/widgets-core";

/**
 * Extracted from the component file so the editor root, the visual editor and the source area can all
 * reference the prop shape without importing each other.
 */
export interface MarkdownRichTextEditorProps extends Pick<
    RichTextEditorProps,
    | "id"
    | "label"
    | "hideLabel"
    | "readonly"
    | "disabled"
    | "error"
    | "warning"
    | "info"
    | "errorMessage"
    | "warningMessage"
    | "infoMessage"
    | "helperText"
    | "placeholder"
> {
    /** Markdown value (canonical storage format). */
    value: string;
    /** Called with serialized markdown on every content change. */
    onMarkdownChange(markdown: string): void;
    /** BufferedInput focus reference — see `BufferedFocusBridgePlugin`. */
    inputRef?: TextAreaStatelessProps["inputRef"];
    /** BufferedInput blur handler — commits the buffered value on blur. */
    onBlur?: TextAreaStatelessProps["onBlur"];
}
