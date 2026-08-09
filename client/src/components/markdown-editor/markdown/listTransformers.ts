import {
    $createListItemNode,
    $createListNode,
    $isListItemNode,
    $isListNode,
    ListItemNode,
    ListNode
} from "@lexical/list";
import type { ElementTransformer } from "@lexical/markdown";
import type { ElementNode, LexicalNode } from "lexical";

/**
 * List transformers adapted from @lexical/markdown 0.31.2 (MIT) with a 2-space
 * indent step instead of Lexical's 4. The w12-free dialect (remark-stringify,
 * "-" bullets) nests lists with 2 spaces; the stock transformers would flatten
 * that nesting on import and emit 4-space nesting on export.
 *
 * Known deviation (spec 007): nested *ordered* lists also serialize with a
 * 2-space step, which strict CommonMark parsers need 3 spaces for ("1. ").
 * Accepted for v1 — bullet nesting (the common case) is byte-aligned.
 *
 * UPGRADE NOTE — `listReplace` structurally diverges from the upstream
 * implementation: it builds nested ListNode/ListItemNode pairs directly and
 * caps the incoming indent at previous-leaf-depth + 1, rather than using
 * upstream's `setIndent` approach. On a Lexical upgrade this file cannot simply
 * be re-copied from upstream; re-evaluate the divergence instead. Re-verified against @lexical/markdown
 * 0.44: upstream still hardcodes a 4-space `LIST_INDENT_SIZE` (not configurable), so this 2-space fork
 * stays required; the check-list `setChecked` after placement (below) is a 0.44 requirement.
 */
const LIST_INDENT_SIZE = 2;
const UNORDERED_LIST_REGEX = /^(\s*)[-*+]\s/;
const ORDERED_LIST_REGEX = /^(\s*)(\d{1,})\.\s/;
// Task-list item: `[ ]` / `[x]` (and empty `[]`), with an OPTIONAL `- ` prefix.
// The prefix is optional on purpose: typing `- ` converts to a bullet
// immediately (the bullet shortcut fires on that space), so the live trigger is
// brackets-first (`[ ] `, `[x] `, …); the `- [ ]` form still parses on
// import/paste. Matched before UNORDERED_LIST_REGEX so `- [ ] ` isn't consumed
// as a bullet. match[1] is the indent; match[2] is the checkbox char (" ",
// "x"/"X", or "" for empty).
const CHECK_LIST_REGEX = /^(\s*)(?:-\s)?\[([ xX]?)\]\s/;

function getIndent(whitespaces: string): number {
    const tabs = whitespaces.match(/\t/g);
    const spaces = whitespaces.match(/ /g);
    let indent = 0;
    if (tabs) {
        indent += tabs.length;
    }
    if (spaces) {
        indent += Math.floor(spaces.length / LIST_INDENT_SIZE);
    }
    return indent;
}

/**
 * Returns the absolute indent level (ancestor ListItemNode count) of the
 * deepest leaf list item reachable from `listNode`'s last child. Used to cap
 * incoming indent values so a 4-space-indented line following a depth-0 item
 * is treated as depth-1 (not depth-2).
 */
function getLastLeafDepth(listNode: ListNode): number {
    const lastChild = listNode.getLastChild();
    if (!lastChild || !$isListItemNode(lastChild)) {
        return 0;
    }
    const firstChild = lastChild.getFirstChild();
    if ($isListNode(firstChild)) {
        return getLastLeafDepth(firstChild);
    }
    return lastChild.getIndent();
}

/**
 * Navigate into `listNode` and return the ListNode at the given nesting `depth`
 * (0 = `listNode` itself, 1 = its last container's sub-list, …). Stops early
 * if the structure doesn't go that deep.
 */
function getListAtDepth(listNode: ListNode, depth: number): ListNode {
    if (depth <= 0) {
        return listNode;
    }
    const lastChild = listNode.getLastChild();
    if (!lastChild || !$isListItemNode(lastChild)) {
        return listNode;
    }
    const firstChild = lastChild.getFirstChild();
    if (!$isListNode(firstChild)) {
        return listNode;
    }
    return getListAtDepth(firstChild, depth - 1);
}

/**
 * Append `listItem` to `listNode` at the given `depth`, creating intermediate
 * container ListItemNode/ListNode pairs as needed. The created sub-list (at the
 * leaf level) always uses `listType` — enabling cross-type nesting
 * (bullet → ordered).
 */
function $appendAtDepth(
    listNode: ListNode,
    listItem: ListItemNode,
    depth: number,
    listType: "bullet" | "number" | "check"
): void {
    if (depth <= 0) {
        listNode.append(listItem);
        return;
    }
    const parentList = getListAtDepth(listNode, depth - 1);
    const lastChild = parentList.getLastChild();
    // If the last child is already a container with a sub-list, reuse it when
    // the sub-list type matches; otherwise create a new sub-list container.
    if (lastChild && $isListItemNode(lastChild)) {
        const firstChild = lastChild.getFirstChild();
        if ($isListNode(firstChild) && firstChild.getListType() === listType) {
            firstChild.append(listItem);
            return;
        }
        if ($isListNode(firstChild)) {
            // Type mismatch on existing sub-list (e.g. bullet below ordered).
            // Nest one more level inside existing container.
            const newContainer = $createListItemNode();
            const newSubList = $createListNode(listType);
            newSubList.append(listItem);
            newContainer.append(newSubList);
            firstChild.append(newContainer);
            return;
        }
        // Last item has content — create a new sub-list container after it.
        const newContainer = $createListItemNode();
        const newSubList = $createListNode(listType);
        newSubList.append(listItem);
        newContainer.append(newSubList);
        parentList.append(newContainer);
        return;
    }
    // parentList is empty — append directly to it
    parentList.append(listItem);
}

function listReplace(listType: "bullet" | "number" | "check"): ElementTransformer["replace"] {
    return (parentNode: ElementNode, children: LexicalNode[], match: string[]) => {
        const previousNode = parentNode.getPreviousSibling();
        const nextNode = parentNode.getNextSibling();
        const checked = listType === "check" ? (match[2] ?? "").toLowerCase() === "x" : undefined;
        const listItem = $createListItemNode(checked);
        const rawIndent = getIndent(match[1] ?? "");

        if (rawIndent === 0 && $isListNode(nextNode) && nextNode.getListType() === listType) {
            const firstChild = nextNode.getFirstChild();
            if (firstChild !== null) {
                firstChild.insertBefore(listItem);
            } else {
                nextNode.append(listItem);
            }
            parentNode.remove();
        } else if (rawIndent === 0 && $isListNode(previousNode) && previousNode.getListType() === listType) {
            previousNode.append(listItem);
            parentNode.remove();
        } else if (rawIndent > 0 && $isListNode(previousNode)) {
            // Cap the indent to at most one level deeper than the previous leaf.
            const prevLeafDepth = getLastLeafDepth(previousNode);
            const cappedIndent = Math.min(rawIndent, prevLeafDepth + 1);
            $appendAtDepth(previousNode, listItem, cappedIndent, listType);
            parentNode.remove();
        } else {
            const list = $createListNode(listType, listType === "number" ? Number(match[2] ?? "1") : undefined);
            list.append(listItem);
            parentNode.replace(list);
        }
        listItem.append(...children);
        // Set the checkbox state only once the item is inside its (check-type) list. Lexical 0.44 gates
        // ListItemNode.getChecked() on the parent list being `check` and clears `__checked` via a node
        // $transform whenever the parent is not a check list — so the value passed to
        // $createListItemNode() before the item is parented does not survive; setChecked() after placement
        // does. (2-space check lists round-trip only with this; verified by markdownTaskList tests.)
        if (listType === "check") {
            listItem.setChecked(checked);
        }
        listItem.select(0, 0);
    };
}

/** The markdown marker for one list item: `1. ` (ordered), `- [x] ` (check), or `- ` (bullet). */
function listItemPrefix(listNode: ListNode, listItem: ListItemNode, index: number): string {
    const listType = listNode.getListType();
    if (listType === "number") {
        return `${listNode.getStart() + index}. `;
    }
    if (listType === "check") {
        return `- [${listItem.getChecked() ? "x" : " "}] `;
    }
    return "- ";
}

function listExport(listNode: ListNode, exportChildren: (node: ElementNode) => string, depth: number): string {
    const output: string[] = [];
    const children = listNode.getChildren();
    let index = 0;
    for (const listItemNode of children) {
        if ($isListItemNode(listItemNode)) {
            if (listItemNode.getChildrenSize() === 1) {
                const firstChild = listItemNode.getFirstChild();
                if ($isListNode(firstChild)) {
                    output.push(listExport(firstChild, exportChildren, depth + 1));
                    continue;
                }
            }
            const indent = " ".repeat(depth * LIST_INDENT_SIZE);
            output.push(indent + listItemPrefix(listNode, listItemNode, index) + exportChildren(listItemNode));
            index++;
        }
    }
    return output.join("\n");
}

export const UNORDERED_LIST_W12: ElementTransformer = {
    dependencies: [ListNode, ListItemNode],
    export: (node, exportChildren) => ($isListNode(node) ? listExport(node, exportChildren, 0) : null),
    regExp: UNORDERED_LIST_REGEX,
    replace: listReplace("bullet"),
    type: "element"
};

export const ORDERED_LIST_W12: ElementTransformer = {
    dependencies: [ListNode, ListItemNode],
    export: (node, exportChildren) => ($isListNode(node) ? listExport(node, exportChildren, 0) : null),
    regExp: ORDERED_LIST_REGEX,
    replace: listReplace("number"),
    type: "element"
};

/**
 * GFM task list (`- [ ]` / `- [x]`, spec 008). Reuses the W12 2-space list
 * machinery so check lists nest with the same dialect as bullet/ordered lists;
 * the stock @lexical/markdown CHECK_LIST would reintroduce 4-space nesting and
 * its own export. `export` delegates to the shared, type-aware `listExport`, so
 * ordering among the three W12 list transformers is irrelevant on export — but
 * on import this MUST precede UNORDERED_LIST_W12 (see CHECK_LIST_REGEX).
 */
export const CHECK_LIST_W12: ElementTransformer = {
    dependencies: [ListNode, ListItemNode],
    export: (node, exportChildren) => ($isListNode(node) ? listExport(node, exportChildren, 0) : null),
    regExp: CHECK_LIST_REGEX,
    replace: listReplace("check"),
    type: "element"
};
