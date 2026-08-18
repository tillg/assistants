import {
    $convertFromMarkdownString,
    $convertToMarkdownString,
    type ElementTransformer,
    type Transformer
} from "@lexical/markdown";
import {
    $createTableCellNode,
    $createTableNode,
    $createTableRowNode,
    $isTableCellNode,
    $isTableNode,
    $isTableRowNode,
    TableCellHeaderStates,
    TableCellNode,
    TableNode,
    TableRowNode
} from "@lexical/table";
import { $isParagraphNode, $isTextNode, type LexicalNode } from "lexical";

const TABLE_ROW_REG_EXP = /^\|(.+)\|\s?$/;
const TABLE_ROW_DIVIDER_REG_EXP = /^(\| ?:?-+:? ?)+\|\s?$/;

function getTableColumnsSize(table: TableNode): number {
    const row = table.getFirstChild();
    return $isTableRowNode(row) ? row.getChildrenSize() : 0;
}

/**
 * GFM pipe tables (spec 007). Adapted from the Lexical playground (v0.31.2);
 * project-maintained — re-check against the playground on Lexical upgrades.
 * Serializes without cell padding/alignment (canonical form, cycle-2 stable;
 * w12-free's padded/aligned tables parse fine and canonicalize).
 *
 * Deliberate deviations from the playground source: `\|` escaping + lookbehind
 * cell split, cell-content trim, `hasHeaderState()` instead of private
 * `__headerState`, divider regex requires ≥1 hyphen per cell (`-+`), strict-TS
 * guards.
 *
 * Cell content is (de)serialized with the full transformer set, supplied lazily
 * via `getTransformers` so this file need not import the transformer registry it
 * is itself part of.
 */
export function createTableTransformer(getTransformers: () => Transformer[]): ElementTransformer {
    function $createTableCell(textContent: string): TableCellNode {
        // Undo only this layer's own `\n` / `\|` escapes, and step over a markdown-escaped `\\` as a
        // unit so its trailing `n` or `|` is not misread as one of ours (that misread turned a literal
        // `\n` the User typed into a real newline, and a trailing `\` swallowed the next cell). The
        // `\\` itself is left intact for the inner markdown parser, which owns backslash escaping.
        const content = unescapeCellStructure(textContent).trim();
        const cell = $createTableCellNode(TableCellHeaderStates.NO_STATUS);
        $convertFromMarkdownString(content, getTransformers(), cell);
        return cell;
    }

    /**
     * Split a table row on its *unescaped* `|` separators. A regex lookbehind cannot tell an escaped
     * backslash (`\\`) before a real separator from an escaped pipe (`\|`), so a cell ending in a
     * backslash would swallow the next cell. Scan instead, stepping over every escape pair intact.
     */
    function splitRowCells(row: string): string[] {
        const cells: string[] = [];
        let current = "";
        for (let index = 0; index < row.length; index += 1) {
            const ch = row[index];
            if (ch === "\\" && index + 1 < row.length) {
                current += ch + row[index + 1];
                index += 1;
                continue;
            }
            if (ch === "|") {
                cells.push(current);
                current = "";
                continue;
            }
            current += ch;
        }
        cells.push(current);
        return cells;
    }

    // Undo this layer's `\n` / `\|` escapes only. A markdown-escaped `\\` is copied through as a unit
    // so its following character is never mistaken for one of ours; every other `\x` keeps its
    // backslash for the inner markdown parser.
    function unescapeCellStructure(text: string): string {
        let out = "";
        for (let index = 0; index < text.length; index += 1) {
            const ch = text[index];
            if (ch === "\\" && index + 1 < text.length) {
                const next = text[index + 1];
                if (next === "\\") {
                    out += "\\\\";
                    index += 1;
                    continue;
                }
                if (next === "n") {
                    out += "\n";
                    index += 1;
                    continue;
                }
                if (next === "|") {
                    out += "|";
                    index += 1;
                    continue;
                }
            }
            out += ch;
        }
        return out;
    }

    function mapToTableCells(textContent: string): TableCellNode[] | null {
        const match = TABLE_ROW_REG_EXP.exec(textContent);
        if (!match?.[1]) {
            return null;
        }
        return splitRowCells(match[1]).map((text) => $createTableCell(text));
    }

    return {
        dependencies: [TableNode, TableRowNode, TableCellNode],
        export: (node: LexicalNode) => {
            if (!$isTableNode(node)) {
                return null;
            }
            const rows: string[][] = [];
            let hasHeaderRow = false;
            for (const row of node.getChildren()) {
                if (!$isTableRowNode(row)) {
                    continue;
                }
                const rowOutput: string[] = [];
                for (const cell of row.getChildren()) {
                    if ($isTableCellNode(cell)) {
                        rowOutput.push(
                            // Escape only the two structural characters that would break a one-line
                            // cell. Backslash itself is the inner markdown's to escape (it emits `\\`),
                            // so this layer must NOT touch it — doing so double-escaped and corrupted
                            // the content. The import side is escape-aware so it does not mistake the
                            // `n` of a markdown-escaped `\\n` for this layer's newline escape.
                            $convertToMarkdownString(getTransformers(), cell)
                                .replace(/\n/g, "\\n")
                                .replace(/\|/g, "\\|")
                                .trim()
                        );
                        if (cell.hasHeaderState(TableCellHeaderStates.ROW)) {
                            hasHeaderRow = true;
                        }
                    }
                }
                rows.push(rowOutput);
            }
            const output: string[] = [];
            rows.forEach((rowOutput, index) => {
                output.push(`| ${rowOutput.join(" | ")} |`);
                // GFM only supports a header in the first row, and its delimiter must be the
                // second line. Emit the divider exactly once after row 0 when the table has any
                // header row — never after a later row, which would produce malformed GFM (the
                // failure mode when a header is shifted off row 0, e.g. via "insert row above").
                if (index === 0 && hasHeaderRow) {
                    output.push(`| ${rowOutput.map(() => "---").join(" | ")} |`);
                }
            });
            return output.join("\n");
        },
        regExp: TABLE_ROW_REG_EXP,
        replace: (parentNode, _1, match) => {
            const matchedLine = match[0];
            if (matchedLine === undefined) {
                return;
            }
            // Divider row: mark the previous row's cells as header cells.
            if (TABLE_ROW_DIVIDER_REG_EXP.test(matchedLine)) {
                const table = parentNode.getPreviousSibling();
                if (!table || !$isTableNode(table)) {
                    return;
                }
                const rows = table.getChildren();
                const lastRow = rows[rows.length - 1];
                if (!lastRow || !$isTableRowNode(lastRow)) {
                    return;
                }
                lastRow.getChildren().forEach((cell) => {
                    if (!$isTableCellNode(cell)) {
                        return;
                    }
                    cell.setHeaderStyles(TableCellHeaderStates.ROW, TableCellHeaderStates.ROW);
                });
                parentNode.remove();
                return;
            }

            const matchCells = mapToTableCells(matchedLine);
            if (matchCells === null) {
                return;
            }

            const rows = [matchCells];
            let sibling = parentNode.getPreviousSibling();
            let maxCells = matchCells.length;

            while (sibling) {
                if (!$isParagraphNode(sibling) || sibling.getChildrenSize() !== 1) {
                    break;
                }
                const firstChild = sibling.getFirstChild();
                if (!$isTextNode(firstChild)) {
                    break;
                }
                const cells = mapToTableCells(firstChild.getTextContent());
                if (cells === null) {
                    break;
                }
                maxCells = Math.max(maxCells, cells.length);
                rows.unshift(cells);
                const previousSibling = sibling.getPreviousSibling();
                sibling.remove();
                sibling = previousSibling;
            }

            const table = $createTableNode();
            for (const cells of rows) {
                const tableRow = $createTableRowNode();
                table.append(tableRow);
                for (let i = 0; i < maxCells; i++) {
                    tableRow.append(cells[i] ?? $createTableCell(""));
                }
            }

            const previousSibling = parentNode.getPreviousSibling();
            if ($isTableNode(previousSibling) && getTableColumnsSize(previousSibling) === maxCells) {
                previousSibling.append(...table.getChildren());
                parentNode.remove();
            } else {
                parentNode.replace(table);
            }
            table.selectEnd();
        },
        type: "element"
    };
}
