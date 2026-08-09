import { $createLinkNode, TOGGLE_LINK_COMMAND } from "@lexical/link";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { $createTextNode, $getSelection, $insertNodes, $isRangeSelection, COMMAND_PRIORITY_EDITOR } from "lexical";
import { useEffect, useState } from "react";

import { Button, ButtonGroup, TextField } from "@com.mgmtp.a12.widgets/widgets-core";

import { RESOURCE_KEYS, useLocalizer } from "../../../localization";

import { OPEN_LINK_DIALOG_COMMAND } from "../commands";

import { EditorDialog, isPlaceholderUrl } from "./EditorDialog";

export function LinkDialogPlugin() {
    const [editor] = useLexicalComposerContext();
    const localize = useLocalizer();
    const [open, setOpen] = useState(false);
    const [url, setUrl] = useState("https://");
    const [text, setText] = useState("");

    useEffect(
        () =>
            editor.registerCommand(
                OPEN_LINK_DIALOG_COMMAND,
                () => {
                    // Pre-fill the link text with the current selection so linking
                    // existing text keeps it as the visible label by default.
                    const selection = $getSelection();
                    setText($isRangeSelection(selection) ? selection.getTextContent() : "");
                    setUrl("https://");
                    setOpen(true);
                    return true;
                },
                COMMAND_PRIORITY_EDITOR
            ),
        [editor]
    );

    const apply = () => {
        const linkText = text.trim();
        if (linkText === "") {
            // No explicit text: link the current selection (its text becomes the label).
            editor.dispatchCommand(TOGGLE_LINK_COMMAND, url);
        } else {
            // Insert a link carrying the given text, replacing any selected range.
            editor.update(() => {
                const linkNode = $createLinkNode(url);
                linkNode.append($createTextNode(linkText));
                $insertNodes([linkNode]);
            });
        }
        setOpen(false);
    };

    return (
        <>
            <LinkPlugin />
            {open && (
                <EditorDialog onClose={() => setOpen(false)}>
                    <TextField
                        label={localize(RESOURCE_KEYS.markdownEditor.link.text)}
                        value={text}
                        onChange={(ev) => setText(ev.target.value)}
                    />
                    <TextField
                        label={localize(RESOURCE_KEYS.markdownEditor.link.url)}
                        value={url}
                        onChange={(ev) => setUrl(ev.target.value)}
                    />
                    <ButtonGroup alignment="right">
                        <Button
                            label={localize(RESOURCE_KEYS.markdownEditor.link.apply)}
                            primary
                            disabled={isPlaceholderUrl(url)}
                            onClick={apply}
                        />
                        <Button
                            label={localize(RESOURCE_KEYS.markdownEditor.link.cancel)}
                            secondary
                            onClick={() => setOpen(false)}
                        />
                    </ButtonGroup>
                </EditorDialog>
            )}
        </>
    );
}
