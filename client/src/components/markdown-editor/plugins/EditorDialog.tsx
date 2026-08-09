import type { ReactNode } from "react";

import { ModalOverlay } from "@com.mgmtp.a12.widgets/widgets-core";

interface EditorDialogProps {
    onClose(): void;
    children: ReactNode;
}

/**
 * Shared modal scaffold for the editor's toolbar dialogs (link, image). Centralises the ModalOverlay
 * configuration so the dialogs cannot drift in sizing or esc/outside-click behaviour. The dialog-specific
 * fields and button row are passed as children. No ThemeProvider re-wrap is needed: the editor is rendered
 * under the app theme, and React context (styled-components theme included) propagates through
 * ModalOverlay's portal via the component tree.
 */
export function EditorDialog({ onClose, children }: EditorDialogProps) {
    return (
        <ModalOverlay closeOnEsc closeOnOutsideClick focusOnOpen maxWidth={420} onClose={onClose}>
            <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "16px" }}>{children}</div>
        </ModalOverlay>
    );
}

/**
 * True when a dialog's URL field is empty or still the untouched `https://` placeholder —
 * inserting either would produce a visibly broken result and junk markdown.
 */
export function isPlaceholderUrl(url: string): boolean {
    return url.trim() === "" || url === "https://";
}
