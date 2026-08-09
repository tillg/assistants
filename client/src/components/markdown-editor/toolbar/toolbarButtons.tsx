import { $createCodeNode, $isCodeNode } from "@lexical/code";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
    $createHeadingNode,
    $createQuoteNode,
    $isHeadingNode,
    $isQuoteNode,
    type HeadingTagType
} from "@lexical/rich-text";
import { $setBlocksType } from "@lexical/selection";
import {
    $createParagraphNode,
    $getSelection,
    $isParagraphNode,
    $isRangeSelection,
    CAN_REDO_COMMAND,
    CAN_UNDO_COMMAND,
    COMMAND_PRIORITY_LOW,
    REDO_COMMAND,
    UNDO_COMMAND,
    type LexicalCommand
} from "lexical";
import { useEffect, useState, type FC, type ReactNode } from "react";

import {
    AlignButtonGroup,
    createBlockButton,
    createButtonGroup,
    createInlineButton,
    Icon,
    IndentDecreaseButton,
    IndentIncreaseButton,
    Separator,
    ToolbarButtonInternal,
    type BaseToolbarButtonProps,
    type ButtonType,
    type StaticToolbarProps
} from "@com.mgmtp.a12.widgets/widgets-core";

import { type Localize, RESOURCE_KEYS } from "../../../localization";

import { OPEN_COLOR_DIALOG_COMMAND, OPEN_LINK_DIALOG_COMMAND } from "../commands";
import { $currentBlock } from "../insertion/blockInsertion";
import { formatShortcutFor } from "../insertion/formatShortcuts";
import { insertableItems } from "../insertion/insertionRegistry";
import { $isListActive, $toggleList, LIST_ITEMS } from "../insertion/listItems";
import { isMacPlatform, withShortcut } from "../insertion/shortcuts";
import { createInsertMenuButton, createPanelToolbarGroup, createTocToolbarButton } from "../insertion/toolbarControls";

import { tableOpsToolbarButtons } from "./tableToolbarButtons";

const IS_MAC = isMacPlatform();

/** Link's shortcut is defined once in the insertion registry; reused here for the toolbar tooltip. */
const LINK_SHORTCUT = insertableItems().find((item) => item.key === "link")?.keyboardShortcut;

/** Paragraph block-type button for the block-type flyout (label-only). */
function paragraphButton(localize: Localize): ButtonType {
    const label = localize(RESOURCE_KEYS.markdownEditor.block.paragraph);
    return createBlockButton({
        label,
        title: label,
        onClick: (event, editor) => {
            editor?.update(() => {
                const selection = $getSelection();
                if (!$isRangeSelection(selection)) {
                    return;
                }
                $setBlocksType(selection, () => $createParagraphNode());
            });
        },
        isActive: (selection) => $isParagraphNode($currentBlock(selection))
    });
}

/** Block-type entry for the block-type popup — label-only so the flyout reads as text. */
function createHeadingButton(tag: HeadingTagType, localize: Localize): ButtonType {
    const level = Number(tag.charAt(1));
    const label = localize(RESOURCE_KEYS.markdownEditor.block.heading, { level: { type: "plain", value: level } });
    return createBlockButton({
        label,
        title: label,
        onClick: (event, editor) => {
            editor?.update(() => {
                const selection = $getSelection();
                if (!$isRangeSelection(selection)) {
                    return;
                }
                const element = $currentBlock(selection);
                if ($isHeadingNode(element) && element.getTag() === tag) {
                    $setBlocksType(selection, () => $createParagraphNode());
                } else {
                    $setBlocksType(selection, () => $createHeadingNode(tag));
                }
            });
        },
        isActive: (selection) => {
            const element = $currentBlock(selection);
            return $isHeadingNode(element) && element.getTag() === tag;
        }
    });
}

/** A block button that toggles the current block between a paragraph and the given block type. */
function toggleBlockButton(
    localize: Localize,
    labelKey: string,
    isBlock: (node: ReturnType<typeof $currentBlock>) => boolean,
    createBlock: Parameters<typeof $setBlocksType>[1]
): ButtonType {
    const label = localize(labelKey);
    return createBlockButton({
        label,
        title: label,
        onClick: (event, editor) => {
            editor?.update(() => {
                const selection = $getSelection();
                if (!$isRangeSelection(selection)) {
                    return;
                }
                if (isBlock($currentBlock(selection))) {
                    $setBlocksType(selection, () => $createParagraphNode());
                } else {
                    $setBlocksType(selection, createBlock);
                }
            });
        },
        isActive: (selection) => isBlock($currentBlock(selection))
    });
}

function quoteButton(localize: Localize): ButtonType {
    return toggleBlockButton(localize, RESOURCE_KEYS.markdownEditor.block.quote, $isQuoteNode, $createQuoteNode);
}

function codeBlockButton(localize: Localize): ButtonType {
    return toggleBlockButton(localize, RESOURCE_KEYS.markdownEditor.block.code, $isCodeNode, $createCodeNode);
}

/**
 * Paragraph + h1–h6 + quote + code block collapsed into one flyout.
 * widgets-core has no native block-type select; createButtonGroup is the
 * available popup primitive. Children are label-only so the flyout reads as a
 * text list (and we avoid relying on looks_4/5/6 glyphs that may be absent from
 * A12's icon font — see spec 006's icon-ligature note).
 */
function blockTypeGroup(localize: Localize): StaticToolbarProps.Item {
    return createButtonGroup({
        icon: <Icon iconTheme="outlined">format_size</Icon>,
        title: localize(RESOURCE_KEYS.markdownEditor.block.typeMenu),
        buttons: [
            paragraphButton(localize),
            createHeadingButton("h1", localize),
            createHeadingButton("h2", localize),
            createHeadingButton("h3", localize),
            createHeadingButton("h4", localize),
            createHeadingButton("h5", localize),
            createHeadingButton("h6", localize),
            quoteButton(localize),
            codeBlockButton(localize)
        ]
    });
}

/**
 * Bullet / numbered / check-list buttons, built from the shared LIST_ITEMS source so the
 * toolbar, slash palette and keyboard shortcuts stay in sync. Each toggles the list and
 * shows its shortcut in the hover tooltip.
 */
function listButtons(localize: Localize): ButtonType[] {
    return LIST_ITEMS.map((def) =>
        createBlockButton({
            icon: def.icon,
            title: withShortcut(localize(def.labelKey), def.keyboardShortcut, IS_MAC),
            onClick: (event, editor) => {
                editor?.update(() => $toggleList(editor, def));
            },
            isActive: (selection) => $isListActive(def, selection)
        })
    );
}

/**
 * Undo / redo — dispatch Lexical's history commands (the editor mounts HistoryPlugin) and
 * disable themselves when the corresponding stack is empty. Enablement is not queryable, so we
 * track Lexical's CAN_UNDO/CAN_REDO broadcasts (fired by HistoryPlugin whenever it changes).
 * Lexical binds the keyboard shortcuts itself; the buttons only surface them in the tooltip.
 * Built directly on ToolbarButtonInternal because createInlineButton's isDisabled is a static
 * per-selection check that cannot observe command broadcasts.
 */

// widgets-core forwards `disabled` to the underlying button at runtime (as its own inline
// buttons do), but the shipped type omits it — re-type locally so we can drive it.
const HistoryToolbarButton = ToolbarButtonInternal as FC<BaseToolbarButtonProps & { disabled?: boolean }>;

function createHistoryButton(config: {
    icon: ReactNode;
    title: string;
    command: LexicalCommand<void>;
    canCommand: LexicalCommand<boolean>;
}): FC<BaseToolbarButtonProps> {
    const HistoryButton: FC<BaseToolbarButtonProps> = ({ dataRole, tabIndex }) => {
        const [editor] = useLexicalComposerContext();
        const [enabled, setEnabled] = useState(false);

        useEffect(
            () =>
                editor.registerCommand(
                    config.canCommand,
                    (canRun) => {
                        setEnabled(canRun);
                        return false;
                    },
                    COMMAND_PRIORITY_LOW
                ),
            [editor]
        );

        return (
            <HistoryToolbarButton
                dataRole={dataRole}
                tabIndex={tabIndex}
                icon={config.icon}
                title={config.title}
                disabled={!enabled}
                onClick={(event, activeEditor) => activeEditor?.dispatchCommand(config.command, undefined)}
            />
        );
    };
    HistoryButton.displayName = "HistoryButton";
    return HistoryButton;
}

/**
 * Toolbar for the markdown editor — markdown-representable formatting only (no underline).
 *
 * Inline formatting, block-type, lists, alignment and the in-table operations are direct buttons.
 * Link and the toggleable directives (panels, TOC) keep their own top-level control;
 * the remaining insert-only features (table, image, horizontal rule) live in the Insert
 * dropdown. All of these are registry-driven, so they share their insertion commands
 * with the slash menu and shortcuts.
 *
 * Built per-localizer (rather than a module constant) so every label resolves against the
 * active locale; the caller memoizes it on the localizer.
 */
export function buildMarkdownToolbarButtons(localize: Localize): StaticToolbarProps.Item[] {
    const { format, history, link } = RESOURCE_KEYS.markdownEditor;

    // Bold/italic are toggled natively by the browser (Ctrl/Cmd+B/I → FORMAT_TEXT_COMMAND); we
    // own the buttons only to surface the shortcut in the hover tooltip. Clicking still toggles.
    const boldButton = createInlineButton({
        nodeFormatType: "bold",
        icon: <Icon iconTheme="outlined">format_bold</Icon>,
        title: withShortcut(localize(format.bold), "mod+b", IS_MAC)
    });

    const italicButton = createInlineButton({
        nodeFormatType: "italic",
        icon: <Icon iconTheme="outlined">format_italic</Icon>,
        title: withShortcut(localize(format.italic), "mod+i", IS_MAC)
    });

    const strikethroughButton = createInlineButton({
        nodeFormatType: "strikethrough",
        icon: <Icon iconTheme="outlined">strikethrough_s</Icon>,
        title: withShortcut(localize(format.strikethrough), formatShortcutFor("strikethrough"), IS_MAC)
    });

    /** Text color — opens the color picker (ColorDialogPlugin) for the selection. */
    const textColorButton = createInlineButton({
        icon: <Icon iconTheme="outlined">format_color_text</Icon>,
        title: localize(format.textColor),
        onClick: (event, editor) => {
            editor?.dispatchCommand(OPEN_COLOR_DIALOG_COMMAND, undefined);
        },
        isActive: () => false
    });

    const linkButton = createInlineButton({
        icon: <Icon iconTheme="outlined">link</Icon>,
        title: withShortcut(localize(link.button), LINK_SHORTCUT, IS_MAC),
        onClick: (event, editor) => {
            editor?.dispatchCommand(OPEN_LINK_DIALOG_COMMAND, undefined);
        },
        isActive: () => false
    });

    const undoButton = createHistoryButton({
        icon: <Icon iconTheme="outlined">undo</Icon>,
        title: withShortcut(localize(history.undo), "mod+z", IS_MAC),
        command: UNDO_COMMAND,
        canCommand: CAN_UNDO_COMMAND
    });

    const redoButton = createHistoryButton({
        icon: <Icon iconTheme="outlined">redo</Icon>,
        title: withShortcut(localize(history.redo), IS_MAC ? "mod+shift+z" : "mod+y", IS_MAC),
        command: REDO_COMMAND,
        canCommand: CAN_REDO_COMMAND
    });

    return [
        undoButton,
        redoButton,
        Separator,
        boldButton,
        italicButton,
        strikethroughButton,
        textColorButton,
        blockTypeGroup(localize),
        ...listButtons(localize),
        IndentDecreaseButton,
        IndentIncreaseButton,
        AlignButtonGroup,
        ...tableOpsToolbarButtons(localize),
        linkButton,
        createPanelToolbarGroup(localize),
        createTocToolbarButton(localize),
        createInsertMenuButton(localize)
    ];
}
