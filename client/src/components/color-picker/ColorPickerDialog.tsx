import { useState } from "react";

import { Button, ButtonGroup, ModalOverlay, TextField } from "@com.mgmtp.a12.widgets/widgets-core";

import { DEFAULT_COLOR, isValidColor, PRESET_COLORS } from "./colors";

export interface ColorPickerLabels {
    readonly hex: string;
    readonly apply: string;
    readonly cancel: string;
    /** When set together with `onClear`, a Clear button is shown. */
    readonly clear?: string;
}

interface ColorPickerDialogProps {
    readonly initialColor?: string;
    readonly presetColors?: readonly string[];
    readonly labels: ColorPickerLabels;
    /**
     * Narrows what counts as an applicable colour; defaults to {@link isValidColor} (hex or CSS colour name).
     * Pass a stricter predicate when the target only accepts a subset — e.g. {@link isSixDigitHexColor} for a
     * document-model colour field — so the dialog can never hand back a value that target rejects. Presets that
     * fail it are not offered.
     */
    isApplicable?(color: string): boolean;
    /** Called with a swatch colour or the (valid) hex/CSS-name typed into the input. The caller closes. */
    onApply(color: string): void;
    /** Optional; when set (with `labels.clear`) a Clear button is shown. The caller closes. */
    onClear?(): void;
    onClose(): void;
}

/**
 * Reusable colour picker dialog: preset swatches + a validated free-form hex/CSS-name input. Presentational
 * only — callers own selection semantics and closing. Extracted from the Markdown-editor colour dialog so the
 * tag colour picker and the editor share one picker. No `ThemeProvider` re-wrap: `ModalOverlay`'s portal
 * propagates React (styled-components) context through the component tree.
 */
export function ColorPickerDialog({
    initialColor,
    presetColors = PRESET_COLORS,
    labels,
    isApplicable = isValidColor,
    onApply,
    onClear,
    onClose
}: ColorPickerDialogProps) {
    const [hex, setHex] = useState(initialColor ?? DEFAULT_COLOR);

    return (
        <ModalOverlay closeOnEsc closeOnOutsideClick focusOnOpen maxWidth={420} onClose={onClose}>
            <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "16px" }}>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                    {presetColors.filter(isApplicable).map((color) => (
                        <Button
                            key={color}
                            title={color}
                            onClick={() => onApply(color)}
                            buttonAttributes={{ "aria-label": color }}
                            style={{ width: "24px", height: "24px", minWidth: "24px", background: color }}
                        />
                    ))}
                </div>
                <TextField label={labels.hex} value={hex} onChange={(ev) => setHex(ev.target.value)} />
                <ButtonGroup alignment="right">
                    <Button
                        label={labels.apply}
                        primary
                        disabled={!isApplicable(hex)}
                        onClick={() => onApply(hex.trim())}
                    />
                    {onClear && labels.clear !== undefined ? (
                        <Button label={labels.clear} secondary onClick={onClear} />
                    ) : null}
                    <Button label={labels.cancel} secondary onClick={onClose} />
                </ButtonGroup>
            </div>
        </ModalOverlay>
    );
}
