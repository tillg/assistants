import { type ChangeEvent, type FocusEvent, useEffect, useRef, useState } from "react";

import { TextAreaStateless } from "@com.mgmtp.a12.widgets/widgets-core";

import type { MarkdownRichTextEditorProps } from "./MarkdownRichTextEditor";

type SourceAreaPassThroughProps = Omit<MarkdownRichTextEditorProps, "value" | "onMarkdownChange">;

interface MarkdownSourceAreaProps extends SourceAreaPassThroughProps {
    value: string;
    onMarkdownChange(markdown: string): void;
}

/**
 * Focus-buffered textarea for markdown source mode.
 *
 * Maintains a local `draft` state so that the form-engine's whitespace-trimming
 * round-trip cannot strip trailing spaces or newlines while the user is typing.
 *
 * Rules:
 *  - While focused: `draft` is authoritative; incoming `value` prop changes are ignored.
 *  - While unfocused: incoming `value` prop changes (e.g. document switch) are adopted
 *    into `draft` so the textarea reflects the external state.
 *  - Every keystroke calls `onMarkdownChange`; while focused this only updates the
 *    BufferedInput buffer (no document commit), which is flushed on blur.
 */
export function MarkdownSourceArea({
    value,
    onMarkdownChange,
    onBlur: bufferedOnBlur,
    ...inputProps
}: MarkdownSourceAreaProps) {
    const [draft, setDraft] = useState(value);
    const focusedRef = useRef(false);

    // Adopt external value changes only when not focused (e.g. document switch).
    useEffect(() => {
        if (!focusedRef.current) {
            setDraft(value);
        }
    }, [value]);

    function handleChange(ev: ChangeEvent<HTMLTextAreaElement>) {
        const newText = ev.target.value;
        setDraft(newText);
        onMarkdownChange(newText);
    }

    function handleFocus() {
        focusedRef.current = true;
    }

    function handleBlur(ev: FocusEvent<HTMLTextAreaElement>) {
        focusedRef.current = false;
        // Flush the buffered value to the document model (BufferedInput commits on blur).
        bufferedOnBlur?.(ev);
    }

    return (
        <TextAreaStateless
            {...inputProps}
            value={draft}
            autoExpand
            style={{ fontFamily: "monospace" }}
            onChange={handleChange}
            onFocus={handleFocus}
            onBlur={handleBlur}
        />
    );
}
