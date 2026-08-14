import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

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

        expect(screen.getByTestId("transcript-bubble")).toHaveTextContent("Booked.");
        expect(screen.queryByTestId("transcript-cost-footnote")).toBeNull();
    });

    it("has no footnote for a Turn whose usage came back as zero", () => {
        renderBubble(entry({ text: "Booked.", promptTokens: 0, completionTokens: 0 }));

        expect(screen.getByTestId("transcript-bubble")).toHaveTextContent("Booked.");
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

    /**
     * domain.md marks `system` and `prompt` *collapsed meta line*, and proposal.md asks that the system
     * prompt stop competing with the dialogue. Rendering them expanded is the whole of that failure, and
     * the fixture carries no `system` Entry, so nothing else here would have caught it.
     */
    it("puts the system prompt away behind its label, since it is long and read once", () => {
        renderBubble(entry({ kind: "system", role: "system", text: SYSTEM_PROMPT }));

        const bubble = screen.getByTestId("transcript-bubble");
        expect(bubble).toHaveTextContent("system");
        expect(bubble).not.toHaveTextContent(SYSTEM_PROMPT);
        expect(screen.getByTestId("transcript-bubble-toggle")).toHaveAttribute("aria-expanded", "false");
    });

    it("shows the system prompt to a reader who asks for it", () => {
        renderBubble(entry({ kind: "system", role: "system", text: SYSTEM_PROMPT }));

        fireEvent.click(screen.getByTestId("transcript-bubble-toggle"));

        expect(screen.getByTestId("transcript-bubble")).toHaveTextContent(SYSTEM_PROMPT);
        expect(screen.getByTestId("transcript-bubble-toggle")).toHaveAttribute("aria-expanded", "true");
    });

    it("puts the Runtime's briefing away the same way", () => {
        renderBubble(entry({ kind: "prompt", role: "user", text: "A new medical invoice has been extracted." }));

        expect(screen.getByTestId("transcript-bubble")).not.toHaveTextContent("A new medical invoice");
        expect(screen.getByTestId("transcript-bubble-toggle")).toBeInTheDocument();
    });

    it("leaves what is read as it comes expanded, with nothing to open", () => {
        renderBubble(entry({ text: "Booked." }));

        expect(screen.getByTestId("transcript-bubble")).toHaveTextContent("Booked.");
        expect(screen.queryByTestId("transcript-bubble-toggle")).toBeNull();
    });

    it("offers no control on a collapsed Entry that carries no text to put away", () => {
        renderBubble(entry({ kind: "prompt", role: "user", text: undefined }));

        expect(screen.getByTestId("transcript-bubble")).toHaveTextContent("prompt");
        expect(screen.queryByTestId("transcript-bubble-toggle")).toBeNull();
    });
});

const SYSTEM_PROMPT = "You are an accountant. Book what you are given, and ask before anything irreversible.";
