import { describe, expect, it } from "vitest";

import { roundTrip } from "../markdownTestUtils";

describe("heading levels (h4-h6)", () => {
    it.each(["# Heading 1", "## Heading 2", "### Heading 3", "#### Heading 4", "##### Heading 5", "###### Heading 6"])(
        "round-trips %j",
        (markdown) => {
            expect(roundTrip(markdown)).toBe(markdown);
        }
    );
});
