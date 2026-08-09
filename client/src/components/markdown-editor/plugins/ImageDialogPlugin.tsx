import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $insertNodes, COMMAND_PRIORITY_EDITOR } from "lexical";
import { useEffect, useState } from "react";

import { Button, ButtonGroup, TextField } from "@com.mgmtp.a12.widgets/widgets-core";

import { RESOURCE_KEYS, useLocalizer } from "../../../localization";

import { $createImageNode } from "../nodes/ImageNode";
import { OPEN_IMAGE_DIALOG_COMMAND } from "../commands";

import { EditorDialog, isPlaceholderUrl } from "./EditorDialog";

/**
 * Handles {@link OPEN_IMAGE_DIALOG_COMMAND}: asks for an image URL plus alt text and inserts an
 * {@link ImageNode}. External URLs only — inline document attachments are not supported here, because
 * resolving them needs a composed document (CDD) that these forms do not have.
 */
export function ImageDialogPlugin() {
    const [editor] = useLexicalComposerContext();
    const localize = useLocalizer();
    const [open, setOpen] = useState(false);
    const [url, setUrl] = useState("https://");
    const [alt, setAlt] = useState("");

    useEffect(
        () =>
            editor.registerCommand(
                OPEN_IMAGE_DIALOG_COMMAND,
                () => {
                    setUrl("https://");
                    setAlt("");
                    setOpen(true);
                    return true;
                },
                COMMAND_PRIORITY_EDITOR
            ),
        [editor]
    );

    if (!open) {
        return null;
    }

    const insert = (src: string, altText: string) => {
        editor.update(() => {
            $insertNodes([$createImageNode({ src, altText })]);
        });
        setOpen(false);
    };

    return (
        <EditorDialog onClose={() => setOpen(false)}>
            <TextField
                label={localize(RESOURCE_KEYS.markdownEditor.image.url)}
                value={url}
                onChange={(ev) => setUrl(ev.target.value)}
            />
            <TextField
                label={localize(RESOURCE_KEYS.markdownEditor.image.alt)}
                value={alt}
                onChange={(ev) => setAlt(ev.target.value)}
            />
            <ButtonGroup alignment="right">
                <Button
                    label={localize(RESOURCE_KEYS.markdownEditor.image.insert)}
                    primary
                    disabled={isPlaceholderUrl(url)}
                    onClick={() => insert(url, alt)}
                />
                <Button
                    label={localize(RESOURCE_KEYS.markdownEditor.image.cancel)}
                    secondary
                    onClick={() => setOpen(false)}
                />
            </ButtonGroup>
        </EditorDialog>
    );
}
