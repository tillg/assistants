import { describe, expect, it } from "vitest";

import { roundTrip } from "../markdownTestUtils";

describe("admonition directive round-trip", () => {
    it.each(["info", "warning", "note", "tip", "panel"])("round-trips a %s panel", (type) => {
        const md = `:::admonition{type="${type}"}\nBody text.\n:::`;
        expect(roundTrip(md)).toBe(md);
    });

    it("round-trips inline marks in the body", () => {
        const md =
            ':::admonition{type="note"}\nNote body containing `inline code` and a [link](https://example.com).\n:::';
        expect(roundTrip(md)).toBe(md);
    });

    it("round-trips bold and emphasis in the body", () => {
        const md = ':::admonition{type="warning"}\nWarning body with **bold** and _emphasis_ marks.\n:::';
        expect(roundTrip(md)).toBe(md);
    });

    it("round-trips a multi-block body (paragraph, list, paragraph)", () => {
        const md =
            ':::admonition{type="missing"}\nMulti-line body for the missing variant:\n\n- pending research\n- needs review\n\nClosing paragraph.\n:::';
        expect(roundTrip(md)).toBe(md);
    });

    it("preserves an unknown variant type verbatim", () => {
        const md = ':::admonition{type="missing"}\nThis content is **missing**.\n:::';
        expect(roundTrip(md)).toBe(md);
    });

    it("keeps two adjacent admonitions separated by a blank line", () => {
        const md = ':::admonition{type="info"}\nFirst.\n:::\n\n:::admonition{type="tip"}\nSecond.\n:::';
        expect(roundTrip(md)).toBe(md);
    });

    it("round-trips a panel surrounded by prose", () => {
        const md = '# Title\n\nIntro paragraph.\n\n:::admonition{type="info"}\nCallout.\n:::\n\nOutro paragraph.';
        expect(roundTrip(md)).toBe(md);
    });

    it("is cycle-2 stable for a nested-list body", () => {
        const md =
            ':::admonition{type="tip"}\nTip body with a nested list:\n\n- first item\n- second item\n- third item\n:::';
        const once = roundTrip(md);
        expect(roundTrip(once)).toBe(once);
    });

    it("tolerates an indented closing fence, canonicalizing it to column 0", () => {
        // A nested-list body can leave the closing `:::` indented; the parser still
        // recognizes the close and the serializer normalizes it (cycle-1 drift),
        // after which it is byte-stable (cycle 2).
        const indented = ':::admonition{type="tip"}\nTip body:\n\n- first item\n- second item\n  :::';
        const md1 = roundTrip(indented);
        expect(md1).toContain("- second item");
        expect(md1).not.toContain("  :::");
        expect(md1.endsWith("\n:::")).toBe(true);
        expect(roundTrip(md1)).toBe(md1);
    });

    it("degrades an unclosed admonition to plain text (no data loss)", () => {
        const md = ':::admonition{type="info"}\nNo closing fence here.';
        // No closing `:::` → not a directive; the lines survive as plain text.
        expect(roundTrip(md)).toContain("No closing fence here.");
        expect(roundTrip(md)).toContain(':::admonition{type="info"}');
    });
});
