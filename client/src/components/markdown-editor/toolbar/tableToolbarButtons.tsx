import {
    $deleteTableColumnAtSelection,
    $deleteTableRowAtSelection,
    $getTableCellNodeFromLexicalNode,
    $getTableNodeFromLexicalNodeOrThrow,
    $insertTableColumnAtSelection,
    $insertTableRowAtSelection
} from "@lexical/table";
import { $getSelection, $isRangeSelection, type BaseSelection } from "lexical";

import { createBlockButton, Icon, type ButtonType } from "@com.mgmtp.a12.widgets/widgets-core";

import { type Localize, RESOURCE_KEYS } from "../../../localization";

/** True when the (range) selection's anchor sits inside a table cell. */
export function $isSelectionInTable(selection: BaseSelection | null): boolean {
    if (!$isRangeSelection(selection)) {
        return false;
    }
    return $getTableCellNodeFromLexicalNode(selection.anchor.getNode()) !== null;
}

function createTableOpButton(icon: string, title: string, op: () => void): ButtonType {
    return createBlockButton({
        icon: <Icon iconTheme="outlined">{icon}</Icon>,
        title,
        onClick: (event, editor) => {
            editor?.update(op);
        },
        isActive: () => false,
        isDisabled: (selection) => !$isSelectionInTable(selection)
    });
}

/**
 * Row/column/table structure operations; enabled only while the cursor is in
 * a table (w12-free's context-aware table controls, as toolbar buttons).
 *
 * The insert functions take `insertAfter?: boolean` (verified against
 * @lexical/table 0.31.2 LexicalTableUtils.d.ts): false = above/left of the
 * current cell, true = below/right.
 */
export function tableOpsToolbarButtons(localize: Localize): ButtonType[] {
    const t = RESOURCE_KEYS.markdownEditor.table;
    return [
        createTableOpButton("vertical_align_top", localize(t.insertRowAbove), () => {
            $insertTableRowAtSelection(false);
        }),
        createTableOpButton("vertical_align_bottom", localize(t.insertRowBelow), () => {
            $insertTableRowAtSelection(true);
        }),
        createTableOpButton("arrow_back", localize(t.insertColumnLeft), () => {
            $insertTableColumnAtSelection(false);
        }),
        createTableOpButton("arrow_forward", localize(t.insertColumnRight), () => {
            $insertTableColumnAtSelection(true);
        }),
        createTableOpButton("delete_sweep", localize(t.deleteRow), () => {
            $deleteTableRowAtSelection();
        }),
        createTableOpButton("delete_outline", localize(t.deleteColumn), () => {
            $deleteTableColumnAtSelection();
        }),
        createTableOpButton("delete_forever", localize(t.deleteTable), () => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection)) {
                return;
            }
            const cell = $getTableCellNodeFromLexicalNode(selection.anchor.getNode());
            if (cell) {
                $getTableNodeFromLexicalNodeOrThrow(cell).remove();
            }
        })
    ];
}
