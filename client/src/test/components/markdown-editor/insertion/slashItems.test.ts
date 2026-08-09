import { describe, expect, it } from "vitest";

import { filterSlashOptions, slashOptions } from "../../../../components/markdown-editor/insertion/slashItems";

/** The slash palette merges core block items with the registry's slash-enabled insertables. */
describe("slash palette options", () => {
    it("merges core block items with the registry insertables", () => {
        const keys = slashOptions().map((option) => option.key);
        // Core block-type / list items.
        expect(keys).toEqual(
            expect.arrayContaining([
                "core:h1",
                "core:h6",
                "core:quote",
                "core:code",
                "core:bullet-list",
                "core:numbered-list",
                "core:check-list"
            ])
        );
        // Registry insertables reachable via slash (including link, which keeps its toolbar button too).
        expect(keys).toEqual(
            expect.arrayContaining(["table", "image", "hr", "admonition:info", "admonition:tip", "toc", "link"])
        );
    });

    it("gives every option a title and a run action", () => {
        for (const option of slashOptions()) {
            expect(option.title).toBeTruthy();
            expect(typeof option.run).toBe("function");
        }
    });

    it("carries the block-list keyboard shortcuts (bound + shown by the shortcut plugin/palette)", () => {
        const shortcut = (key: string) => slashOptions().find((option) => option.key === key)?.shortcut;
        expect(shortcut("core:bullet-list")).toBe("mod+alt+b");
        expect(shortcut("core:numbered-list")).toBe("mod+alt+u");
        expect(shortcut("core:check-list")).toBe("mod+alt+s");
        // Registry insertables still expose their shortcut through the palette too.
        expect(shortcut("table")).toBe("mod+alt+a");
        expect(shortcut("toc")).toBe("mod+alt+o");
        // Headings/quote/code stay unbound.
        expect(shortcut("core:h1")).toBeUndefined();
        expect(shortcut("core:quote")).toBeUndefined();
    });

    it("returns the full list for an empty query", () => {
        expect(filterSlashOptions(slashOptions(), "")).toHaveLength(slashOptions().length);
        expect(filterSlashOptions(slashOptions(), null)).toHaveLength(slashOptions().length);
    });

    it("filters by title and by keyword, case-insensitively", () => {
        const byTitle = filterSlashOptions(slashOptions(), "Head").map((option) => option.key);
        expect(byTitle).toContain("core:h1");
        expect(byTitle).not.toContain("table");

        // "panel" matches the admonition variants via keyword, not the block-type items.
        const byKeyword = filterSlashOptions(slashOptions(), "panel").map((option) => option.key);
        expect(byKeyword).toContain("admonition:panel");
        expect(byKeyword).toContain("admonition:info"); // shares the "panel" entry keyword
        expect(byKeyword).not.toContain("core:quote");

        expect(filterSlashOptions(slashOptions(), "TOC").map((option) => option.key)).toContain("toc");
    });
});
