import { describe, expect, it } from "vitest";

import { roundTrip } from "../markdownTestUtils";

describe("toc directive round-trip", () => {
    it("round-trips the default range", () => {
        const md = ':::toc{minLevel="1" maxLevel="6"}\n:::';
        expect(roundTrip(md)).toBe(md);
    });

    it("round-trips a custom range", () => {
        const md = ':::toc{minLevel="2" maxLevel="3"}\n:::';
        expect(roundTrip(md)).toBe(md);
    });

    it("round-trips a degenerate range without swapping (min > max)", () => {
        const md = ':::toc{minLevel="6" maxLevel="1"}\n:::';
        expect(roundTrip(md)).toBe(md);
    });

    it("clamps out-of-range levels to 1..6 on import", () => {
        expect(roundTrip(':::toc{minLevel="0" maxLevel="9"}\n:::')).toBe(':::toc{minLevel="1" maxLevel="6"}\n:::');
    });

    it("defaults missing attributes to 1..6", () => {
        expect(roundTrip(":::toc\n:::")).toBe(':::toc{minLevel="1" maxLevel="6"}\n:::');
    });

    it("discards any incoming body (atom)", () => {
        expect(roundTrip(':::toc{minLevel="1" maxLevel="6"}\nstray body\n:::')).toBe(
            ':::toc{minLevel="1" maxLevel="6"}\n:::'
        );
    });

    it("round-trips a toc among headings", () => {
        const md = '# One\n\n:::toc{minLevel="1" maxLevel="6"}\n:::\n\n## Two';
        expect(roundTrip(md)).toBe(md);
    });
});
