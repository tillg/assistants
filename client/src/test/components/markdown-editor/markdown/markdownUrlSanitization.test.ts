import { describe, expect, it } from "vitest";

import { roundTrip } from "../markdownTestUtils";

describe("URL sanitization is render-only (storage unchanged)", () => {
    it("keeps a javascript: link URL verbatim in the stored markdown", () => {
        // The guard runs at the render layer; the markdown is never rewritten.
        expect(roundTrip("[x](javascript:alert)")).toBe("[x](javascript:alert)");
    });

    it("keeps a data: image src verbatim in the stored markdown", () => {
        expect(roundTrip("![a](data:image/png;base64,iVBOR)")).toBe("![a](data:image/png;base64,iVBOR)");
    });
});
