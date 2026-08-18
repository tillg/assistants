import { describe, expect, it } from "vitest";

import { readEntries } from "../../../components/conversation/entries";
import { speakerFor } from "../../../components/conversation/speaker";
import fixture from "../../fixtures/conversation.json";

/** One case per row of functional.md's Speaker table; that table is the whole of the Transcript's semantics. */
describe("speakerFor", () => {
    it("puts the Assistant's prose on the left", () => {
        expect(speakerFor("assistant")).toEqual({
            speaker: "assistant",
            side: "left",
            shape: "prose",
            collapsed: false,
            warning: false
        });
    });

    it("puts the User's own words on the accent side", () => {
        expect(speakerFor("answer")).toEqual({
            speaker: "human",
            side: "right",
            shape: "prose",
            collapsed: false,
            warning: false
        });
    });

    it("makes a call a Receipt, closed", () => {
        expect(speakerFor("tool-intent", "bookkeeping.postTransaction")).toEqual({
            speaker: "tool",
            side: "left",
            shape: "receipt",
            collapsed: true,
            warning: false
        });
    });

    it("makes what came back the same Receipt", () => {
        expect(speakerFor("tool-result", "bookkeeping.postTransaction")).toEqual({
            speaker: "tool",
            side: "left",
            shape: "receipt",
            collapsed: true,
            warning: false
        });
    });

    it("treats the Assistant asking as speech rather than as a Receipt", () => {
        expect(speakerFor("tool-intent", "ui.askUser")).toEqual({
            speaker: "assistant",
            side: "left",
            shape: "question",
            collapsed: false,
            warning: false
        });
    });

    it("collapses the system prompt, which is long and read once", () => {
        expect(speakerFor("system")).toEqual({
            speaker: "machinery",
            side: "centre",
            shape: "meta",
            collapsed: true,
            warning: false,
            label: "system"
        });
    });

    it("treats the briefing as Machinery, not as the human speaking", () => {
        const briefing = readEntries(fixture)[0];

        // The Runtime's briefing occupies the `user` role in the API, and reading `role` to decide the
        // side would put it in the User's colour — a lie about who said it.
        expect(briefing?.kind).toBe("prompt");
        expect(briefing?.role).toBe("user");
        expect(speakerFor("prompt")).toEqual({
            speaker: "machinery",
            side: "centre",
            shape: "meta",
            collapsed: true,
            warning: false,
            label: "prompt"
        });
    });

    it("puts a note in the middle", () => {
        expect(speakerFor("note")).toEqual({
            speaker: "machinery",
            side: "centre",
            shape: "meta",
            collapsed: false,
            warning: false,
            label: "note"
        });
    });

    it("warns on a timeout", () => {
        expect(speakerFor("timeout")).toEqual({
            speaker: "machinery",
            side: "centre",
            shape: "meta",
            collapsed: false,
            warning: true,
            label: "timeout"
        });
    });

    it("warns on an error", () => {
        expect(speakerFor("error")).toEqual({
            speaker: "machinery",
            side: "centre",
            shape: "meta",
            collapsed: false,
            warning: true,
            label: "error"
        });
    });

    it("says what an approval record is, since it carries no text of its own", () => {
        expect(speakerFor("approval-request")).toEqual({
            speaker: "machinery",
            side: "centre",
            shape: "meta",
            collapsed: false,
            warning: false,
            label: "🛑 approval requested"
        });
    });

    it("degrades an unknown kind to Machinery and keeps the kind visible", () => {
        expect(speakerFor("quantum-flux")).toEqual({
            speaker: "machinery",
            side: "centre",
            shape: "meta",
            collapsed: false,
            warning: false,
            label: "quantum-flux"
        });
    });

    it("has an answer for every kind the fixture carries", () => {
        for (const entry of readEntries(fixture)) {
            expect(speakerFor(entry.kind, entry.toolName).speaker).toBeDefined();
        }
    });
});
