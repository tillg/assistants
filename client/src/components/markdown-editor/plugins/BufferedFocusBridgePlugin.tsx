import { useEffect, type FocusEvent } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { BLUR_COMMAND, COMMAND_PRIORITY_LOW } from "lexical";

import type { TextAreaStatelessProps } from "@com.mgmtp.a12.widgets/widgets-core";

export interface BufferedFocusBridgeProps {
    /** The form engine's BufferedInput `inputRef` callback (identifies the focused element). */
    inputRef?: TextAreaStatelessProps["inputRef"];
    /** The form engine's BufferedInput blur handler (commits the buffered value). */
    onBlur?: TextAreaStatelessProps["onBlur"];
}

/**
 * Bridges the Lexical editor into the form engine's BufferedInput focus contract.
 *
 * BufferedInput buffers changes (local state only) while `document.activeElement === inputRef`
 * and commits to the document model on blur. Without this bridge the markdown widget never
 * registers an `inputRef`, so every keystroke is treated as an "autofill" submit — committing
 * the whole document and re-rendering the entire form on each keypress.
 *
 * The contenteditable root is `document.activeElement` while the user types, so we register it
 * as the buffered input's ref and forward Lexical's BLUR_COMMAND to the buffered blur handler.
 * Result: typing buffers locally, the form commits once on blur (like every other A12 field).
 */
export function BufferedFocusBridgePlugin({ inputRef, onBlur }: BufferedFocusBridgeProps) {
    const [editor] = useLexicalComposerContext();

    useEffect(() => {
        if (!inputRef && !onBlur) {
            return;
        }
        // RefCallback is typed for <textarea>; the contenteditable is an HTMLElement. The ref is
        // only used for an identity comparison against document.activeElement, so the concrete
        // element type is irrelevant at runtime.
        const unregisterRoot = inputRef
            ? editor.registerRootListener((rootElement) => inputRef(rootElement as HTMLTextAreaElement | null))
            : undefined;
        const unregisterBlur = onBlur
            ? editor.registerCommand(
                  BLUR_COMMAND,
                  (event) => {
                      onBlur(event as unknown as FocusEvent<HTMLTextAreaElement>);
                      return false;
                  },
                  COMMAND_PRIORITY_LOW
              )
            : undefined;
        return () => {
            unregisterRoot?.();
            unregisterBlur?.();
            inputRef?.(null);
        };
    }, [editor, inputRef, onBlur]);

    return null;
}
