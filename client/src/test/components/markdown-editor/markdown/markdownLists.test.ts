import { describe, expect, it } from "vitest";

import { roundTrip } from "../markdownTestUtils";

describe("list nesting (2-space indent, w12-free dialect)", () => {
    it.each([
        "- top\n  - nested\n    - deeper",
        "- bullet one\n- bullet two\n  - nested bullet",
        "1. first\n2. second",
        "- a\n  1. nested ordered",
        "- a\n  - b\n    - c\n  - d",
        "1. first\n  1. nested ordered"
    ])("round-trips %j", (markdown) => {
        expect(roundTrip(markdown)).toBe(markdown);
    });

    it("canonicalizes 4-space nesting to 2-space", () => {
        expect(roundTrip("- top\n    - nested")).toBe("- top\n  - nested");
    });

    it("caps multi-level indent jumps at one level deeper", () => {
        expect(roundTrip("- a\n      - x")).toBe("- a\n  - x");
    });
});
