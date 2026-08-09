import {
    $isListNode,
    $removeList,
    INSERT_CHECK_LIST_COMMAND,
    INSERT_ORDERED_LIST_COMMAND,
    INSERT_UNORDERED_LIST_COMMAND
} from "@lexical/list";
import { $getSelection, type BaseSelection, type LexicalCommand, type LexicalEditor } from "lexical";
import type { ReactNode } from "react";

import { Icon } from "@com.mgmtp.a12.widgets/widgets-core";

import { RESOURCE_KEYS } from "../../../localization";

import { $currentBlock } from "./blockInsertion";

/**
 * The three list block types, defined once and shared by every surface: the toolbar
 * buttons, the slash palette, and the keyboard-shortcut binder. Each toggles — applying
 * the list, or converting back to paragraphs when the selection is already that list
 * type (mirroring the block-type/panel/TOC toggle buttons).
 */
export interface ListDef {
    key: string;
    /** English label — keyword-derivation source and no-localizer fallback. */
    displayName: string;
    /** Resource key resolved to the surface-rendered (localized) label. */
    labelKey: string;
    icon: ReactNode;
    listType: "bullet" | "number" | "check";
    insertCommand: LexicalCommand<void>;
    keywords: readonly string[];
    keyboardShortcut: string;
}

const outlined = (name: string): ReactNode => <Icon iconTheme="outlined">{name}</Icon>;

export const LIST_ITEMS: readonly ListDef[] = [
    {
        key: "core:bullet-list",
        displayName: "Bullet list",
        labelKey: RESOURCE_KEYS.markdownEditor.block.bulletList,
        icon: outlined("format_list_bulleted"),
        listType: "bullet",
        insertCommand: INSERT_UNORDERED_LIST_COMMAND,
        keywords: ["bullet", "unordered", "list", "ul"],
        keyboardShortcut: "mod+alt+b"
    },
    {
        key: "core:numbered-list",
        displayName: "Numbered list",
        labelKey: RESOURCE_KEYS.markdownEditor.block.numberedList,
        icon: outlined("format_list_numbered"),
        listType: "number",
        insertCommand: INSERT_ORDERED_LIST_COMMAND,
        keywords: ["numbered", "ordered", "list", "ol"],
        keyboardShortcut: "mod+alt+u"
    },
    {
        key: "core:check-list",
        displayName: "Check list",
        labelKey: RESOURCE_KEYS.markdownEditor.block.checkList,
        icon: outlined("checklist"),
        listType: "check",
        insertCommand: INSERT_CHECK_LIST_COMMAND,
        keywords: ["check", "task", "todo", "list"],
        keyboardShortcut: "mod+alt+s"
    }
];

/** True when the selection's block is already a list of this type (toolbar active state / toggle test). */
export function $isListActive(def: ListDef, selection: BaseSelection | null): boolean {
    const element = $currentBlock(selection);
    return $isListNode(element) && element.getListType() === def.listType;
}

/**
 * Toggle the list at the selection — runs inside an editor update. Already this list
 * type → unwrap it back to paragraphs (`$removeList`, so it doesn't depend on
 * REMOVE_LIST_COMMAND being registered); otherwise apply the list.
 */
export function $toggleList(editor: LexicalEditor, def: ListDef): void {
    if ($isListActive(def, $getSelection())) {
        $removeList();
    } else {
        editor.dispatchCommand(def.insertCommand, undefined);
    }
}
