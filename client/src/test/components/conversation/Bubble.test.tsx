import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { Bubble } from "../../../components/conversation/Bubble";
import type { TranscriptEntry } from "../../../components/conversation/entries";

import { Frame } from "./harness";

function entry(rest: Partial<TranscriptEntry> = {}): TranscriptEntry {
    return { seq: 1, at: "2026-08-13T18:42:48", role: "assistant", kind: "assistant", ...rest };
}

function renderBubble(subject: TranscriptEntry) {
    return render(
        <Frame>
            <Bubble entry={subject} />
        </Frame>
    );
}

describe("Bubble", () => {
    it("names its Speaker with the icon that Speaker has", () => {
        renderBubble(entry({ text: "Booked." }));

        expect(screen.getByTestId("transcript-bubble")).toHaveTextContent("🤖");
    });

    it("shows the User's own words on the accent side, with the human icon", () => {
        renderBubble(entry({ kind: "answer", role: "user", text: "Yes, please book it." }));

        const bubble = screen.getByTestId("transcript-bubble");
        expect(bubble.dataset["side"]).toBe("right");
        expect(bubble).toHaveTextContent("👦🏼");
        expect(bubble).toHaveTextContent("Yes, please book it.");
    });

    it("footnotes what the Turn that wrote it recorded", () => {
        renderBubble(entry({ text: "Booked.", promptTokens: 120, completionTokens: 34 }));

        expect(screen.getByTestId("transcript-cost-footnote")).toHaveTextContent("120 + 34 tokens");
    });

    it("has no footnote when nothing was recorded", () => {
        renderBubble(entry({ text: "Booked." }));

        expect(screen.queryByTestId("transcript-cost-footnote")).toBeNull();
    });

    it("has no footnote for a Turn whose usage came back as zero", () => {
        renderBubble(entry({ text: "Booked.", promptTokens: 0, completionTokens: 0 }));

        expect(screen.queryByTestId("transcript-cost-footnote")).toBeNull();
    });

    it("renders an approval record as a centred meta line, though it carries no text", () => {
        renderBubble(entry({ kind: "approval-request", text: undefined }));

        const bubble = screen.getByTestId("transcript-bubble");
        expect(bubble.dataset["side"]).toBe("centre");
        expect(bubble).toHaveTextContent("🛑 approval requested");
    });

    it("shows an unknown kind by its own name rather than dropping it", () => {
        renderBubble(entry({ kind: "telepathy", text: "…" }));

        expect(screen.getByTestId("transcript-bubble")).toHaveTextContent("telepathy");
    });
});
