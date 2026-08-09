import { describe, expect, it } from "vitest";

import { roundTrip } from "../markdownTestUtils";

describe("markdown round-trip", () => {
    it.each([
        "# Heading 1",
        "## Heading 2",
        "### Heading 3",
        "**bold**",
        "_italic_",
        "~~strikethrough~~",
        "- item 1\n- item 2",
        "1. first\n2. second",
        "> a quote",
        "`inline code`",
        "```\ncode block\n```",
        "[label](https://example.com)",
        "# Title\n\nA paragraph with **bold** and a [link](https://example.com).\n\n- one\n- two",
        "",
        "para1\n\npara2",
        "# Heading\n\ntext after blank line",
        "- item 1\n- item 2\n\nafter the list"
    ])("preserves %j", (markdown) => {
        expect(roundTrip(markdown)).toBe(markdown);
    });

    // The stored dialect is w12-free's remark canonical form (alignment design 2026-06-10):
    // _italic_, **bold**, **_bold italic_**, blank line between blocks.
    it("canonicalizes to the w12-free dialect", () => {
        expect(roundTrip("*italic*")).toBe("_italic_");
        expect(roundTrip("__bold__")).toBe("**bold**");
        expect(roundTrip("***bold italic***")).toBe("**_bold italic_**");
    });

    it("is stable: a second round-trip changes nothing (cycle-2 invariant)", () => {
        const input = "# T\n\n**b** *i* ~~s~~\n\n> q\n\n- a\n- b";
        const once = roundTrip(input);
        expect(roundTrip(once)).toBe(once);
    });

    it("keeps unsupported raw HTML as literal text", () => {
        expect(roundTrip("<script>alert(1)</script>")).toContain("alert(1)");
    });

    it("round-trips the original smoke document unchanged", () => {
        expect(roundTrip("# Hello W12\n\nSome **bold** text and a list:\n\n- first item\n- second item")).toBe(
            "# Hello W12\n\nSome **bold** text and a list:\n\n- first item\n- second item"
        );
    });
});
