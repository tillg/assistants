import { describe, expect, it } from "vitest";

import { formatRecordedCost, recordedCost } from "../../../components/conversation/cost";
import { readEntries, type TranscriptEntry } from "../../../components/conversation/entries";
import fixture from "../../fixtures/conversation.json";

function entry(rest: Partial<TranscriptEntry> = {}): TranscriptEntry {
    return { seq: 1, at: "2026-08-13T10:00:00", role: "assistant", kind: "assistant", ...rest };
}

describe("recordedCost", () => {
    it("sums prompt and completion tokens across the Entries", () => {
        expect(
            recordedCost([
                entry({ promptTokens: 1200, completionTokens: 34 }),
                entry({ promptTokens: 1400, completionTokens: 96 })
            ])
        ).toBe(2730);
    });

    it("counts a half-stamped Entry for what it carries", () => {
        expect(recordedCost([entry({ promptTokens: 1200 }), entry({ completionTokens: 34 })])).toBe(1234);
    });

    it("lets Entries without usage contribute nothing", () => {
        // The fixture comes from the scripted provider, which reports zero — so every Entry in it either
        // carries no usage at all or carries zeroes, and the total is the same either way.
        expect(recordedCost(readEntries(fixture))).toBe(0);
    });

    it("yields zero rather than NaN for a Conversation with no Entries", () => {
        expect(recordedCost(readEntries({ Conversation: {} }))).toBe(0);
    });
});

describe("formatRecordedCost", () => {
    it("always says at least, because a Turn that died before writing an Entry recorded nothing", () => {
        expect(formatRecordedCost(0)).toMatch(/^≥ /);
        expect(formatRecordedCost(2730)).toMatch(/^≥ /);
    });

    it("groups digits the way the reader's locale does", () => {
        expect(formatRecordedCost(1234567, "en-GB")).toBe(`≥ ${new Intl.NumberFormat("en-GB").format(1234567)} tokens`);
        expect(formatRecordedCost(1234567, "de-DE")).toBe(`≥ ${new Intl.NumberFormat("de-DE").format(1234567)} tokens`);
    });

    it("does not group with a separator of its own", () => {
        // Same figure, two locales, two groupings — so the separator cannot be hardcoded.
        expect(formatRecordedCost(1234567, "en-GB")).not.toBe(formatRecordedCost(1234567, "de-DE"));
    });

    it("falls back to the browser's own locale", () => {
        expect(formatRecordedCost(1234567)).toBe(`≥ ${new Intl.NumberFormat().format(1234567)} tokens`);
    });
});
