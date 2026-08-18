import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import { $createTableCellNode, $createTableNode, $createTableRowNode, TableCellHeaderStates } from "@lexical/table";
import { describe, expect, it } from "vitest";

import { $nodesToMarkdown } from "../../../../components/markdown-editor/markdown/markdownConversion";

import { createTestEditor, roundTrip } from "../markdownTestUtils";

describe("TABLE transformer", () => {
    it.each([
        // canonical 2x2 (the insert-table shape)
        "| A | B |\n| --- | --- |\n| 1 | 2 |",
        // empty cells survive
        "| A |  |\n| --- | --- |\n| 1 |  |",
        // escaped pipe inside a cell
        "| a\\|b | c |\n| --- | --- |\n| 1 | 2 |",
        // inline formatting in cells
        "| **bold** | _em_ |\n| --- | --- |\n| `code` | [l](https://e.com) |",
        // BUG-17: a literal backslash-n the User typed stays literal, not a newline
        "| foo\\\\nbar | c |\n| --- | --- |\n| 1 | 2 |",
        // BUG-17: a cell ending in a backslash does not swallow the next cell
        "| x\\\\ | y |\n| --- | --- |\n| 1 | 2 |"
    ])("round-trips %j", (markdown) => {
        expect(roundTrip(markdown)).toBe(markdown);
    });

    it("canonicalizes padded/aligned tables (cycle-2 stable)", () => {
        const padded = "| Name  |   Role   |\n| :---- | :------: |\n| Alice |   Lead   |";
        const md1 = roundTrip(padded);
        expect(md1).toBe("| Name | Role |\n| --- | --- |\n| Alice | Lead |");
        expect(roundTrip(md1)).toBe(md1);
    });

    it("keeps a lone pipe-less line as text", () => {
        expect(roundTrip("a | b")).toBe("a | b");
    });

    it("keeps an all-empty body row (not a header divider)", () => {
        const table = "| A | B |\n| --- | --- |\n|  |  |";
        expect(roundTrip(table)).toBe(table);
    });

    it("canonicalizes a literal \\n escape in a cell once, then stays stable", () => {
        const md1 = roundTrip("| a\\nb | c |\n| --- | --- |\n| 1 | 2 |");
        expect(md1).toBe("| a\\n\\nb | c |\n| --- | --- |\n| 1 | 2 |");
        expect(roundTrip(md1)).toBe(md1);
    });

    // Regression: a header row shifted off row 0 (e.g. via "insert row above") must still
    // export the GFM divider exactly once, as the second line — not after the header row,
    // which produced malformed markdown that mis-parsed on re-import.
    it("emits the divider only after the first row when the header is not row 0", () => {
        const editor = createTestEditor();
        editor.update(
            () => {
                const buildRow = (texts: string[], headerState: number) => {
                    const row = $createTableRowNode();
                    for (const text of texts) {
                        const cell = $createTableCellNode(headerState);
                        cell.append($createParagraphNode().append($createTextNode(text)));
                        row.append(cell);
                    }
                    return row;
                };
                const table = $createTableNode();
                // A non-header row sits above the header row (the "insert row above" shape).
                table.append(
                    buildRow(["", ""], TableCellHeaderStates.NO_STATUS),
                    buildRow(["A", "B"], TableCellHeaderStates.ROW)
                );
                $getRoot().append(table);
            },
            { discrete: true }
        );

        let md = "";
        editor.getEditorState().read(() => {
            md = $nodesToMarkdown();
        });
        const lines = md.split("\n");
        const dividerLines = lines.filter((line) => /^\|(?: ?:?-+:? ?\|)+\s*$/.test(line));
        expect(dividerLines).toHaveLength(1);
        expect(lines[1]).toBe("| --- | --- |");
    });
});
