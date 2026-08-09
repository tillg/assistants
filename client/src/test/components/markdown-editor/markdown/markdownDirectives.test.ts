import { describe, expect, it } from "vitest";

import {
    parseDirectiveAttributes,
    serializeDirectiveAttributes
} from "../../../../components/markdown-editor/markdown/directives";

import { roundTrip } from "../markdownTestUtils";

describe("directive attribute helpers", () => {
    it("parses quoted key/value pairs", () => {
        expect(parseDirectiveAttributes('type="info"')).toEqual({ type: "info" });
        expect(parseDirectiveAttributes('minLevel="2" maxLevel="3"')).toEqual({ minLevel: "2", maxLevel: "3" });
    });

    it("returns an empty map for empty/undefined input", () => {
        expect(parseDirectiveAttributes(undefined)).toEqual({});
        expect(parseDirectiveAttributes("")).toEqual({});
    });

    it("serializes ordered pairs", () => {
        expect(serializeDirectiveAttributes([["type", "warning"]])).toBe('type="warning"');
        expect(
            serializeDirectiveAttributes([
                ["minLevel", "1"],
                ["maxLevel", "6"]
            ])
        ).toBe('minLevel="1" maxLevel="6"');
    });
});

describe("unknown directives survive as plain text (AC 3)", () => {
    it.each([
        ':::somethingelse{x="1"}\nbody\n:::',
        "::leafdirective{a=1}",
        ":notadirective inline",
        ":::columns\n:::column\nx\n:::\n:::"
    ])("does not consume %j", (md) => {
        // No name-specific transformer matches → the content survives verbatim.
        expect(roundTrip(md)).toBe(md);
    });
});

describe("colon-before-digit/letter content is not corrupted (AC 4)", () => {
    it.each([
        "The build runs daily at 16:00.",
        "It listens on :443 only.",
        "The ratio 1:1 mapping applies.",
        "Open the file:First then continue.",
        "git master:branch sync",
        "Times 9:30, 12:00 and 16:45."
    ])("round-trips %j unchanged", (md) => {
        expect(roundTrip(md)).toBe(md);
    });
});
