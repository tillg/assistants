import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $patchStyleText } from "@lexical/selection";
import { $getSelection, $isRangeSelection, COMMAND_PRIORITY_EDITOR, type BaseSelection } from "lexical";
import { useEffect, useState } from "react";

import { $isInlineStyleTextNode } from "@com.mgmtp.a12.widgets/widgets-core";

import { ColorPickerDialog } from "../../color-picker/ColorPickerDialog";
import { DEFAULT_COLOR } from "../../color-picker/colors";
import { RESOURCE_KEYS, useLocalizer } from "../../../localization";

import { OPEN_COLOR_DIALOG_COMMAND } from "../commands";
import { extractColor } from "../markdown/colorTransformer";

/** The color of the first colored run in the selection, so re-opening on colored text prefills it. */
function selectionColor(selection: BaseSelection | null): string | null {
    if (!$isRangeSelection(selection)) {
        return null;
    }
    for (const node of selection.getNodes()) {
        if ($isInlineStyleTextNode(node)) {
            const color = extractColor(node.getStyle());
            if (color !== null) {
                return color;
            }
        }
    }
    return null;
}

/**
 * Toolbar-driven text-color picker. Applies the chosen color (a hex literal or a
 * CSS color name) as an inline `color` style on the selection via $patchStyleText
 * (serialized by the COLOR transformer),
 * and marks the styled runs unmergeable so A12's InlineStyleTextNode merge listener
 * does not merge them back into their plain neighbors and drop the color. "Clear
 * color" removes the color (and the unmergeable flag so the run can rejoin its
 * neighbors). Mirrors the LinkDialogPlugin pattern. The picker UI is the shared
 * {@link ColorPickerDialog}.
 */
export function ColorDialogPlugin() {
    const [editor] = useLexicalComposerContext();
    const localize = useLocalizer();
    const [open, setOpen] = useState(false);
    const [initialColor, setInitialColor] = useState(DEFAULT_COLOR);

    useEffect(
        () =>
            editor.registerCommand(
                OPEN_COLOR_DIALOG_COMMAND,
                () => {
                    setInitialColor(selectionColor($getSelection()) ?? DEFAULT_COLOR);
                    setOpen(true);
                    return true;
                },
                COMMAND_PRIORITY_EDITOR
            ),
        [editor]
    );

    const patchColor = (color: string | null) => {
        editor.update(() => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection)) {
                return;
            }
            $patchStyleText(selection, { color });
            // TODO: remove when A12-19022 is fixed
            for (const node of selection.getNodes()) {
                if ($isInlineStyleTextNode(node)) {
                    if (extractColor(node.getStyle()) !== null) {
                        node.setUnmergeable();
                    } else {
                        node.removeUnmergeable();
                    }
                }
            }
        });
        setOpen(false);
    };

    if (!open) {
        return null;
    }

    return (
        <ColorPickerDialog
            initialColor={initialColor}
            labels={{
                hex: localize(RESOURCE_KEYS.markdownEditor.color.hex),
                apply: localize(RESOURCE_KEYS.markdownEditor.color.apply),
                clear: localize(RESOURCE_KEYS.markdownEditor.color.clear),
                cancel: localize(RESOURCE_KEYS.markdownEditor.color.cancel)
            }}
            onApply={(color) => patchColor(color)}
            onClear={() => patchColor(null)}
            onClose={() => setOpen(false)}
        />
    );
}
