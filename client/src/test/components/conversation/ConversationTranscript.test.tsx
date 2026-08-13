import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { ConversationTranscript } from "../../../components/conversation/ConversationTranscript";
import fixture from "../../fixtures/conversation.json";

import { Frame } from "./harness";

/** A Conversation document with just the Entries a case is about. */
function conversationWith(entries: readonly object[]): object {
    return { Conversation: { AssistantKey: "accountant", Title: "Accountant", Entries: entries } };
}

function renderTranscript(document: object) {
    return render(
        <Frame>
            <ConversationTranscript document={document} />
        </Frame>
    );
}

describe("ConversationTranscript", () => {
    it("renders the fixture's thirteen Entries as six Bubbles and four Receipts", () => {
        renderTranscript(fixture);

        expect(screen.getAllByTestId("transcript-bubble").map((bubble) => bubble.dataset["seq"])).toEqual([
            "1",
            "4",
            "6",
            "8",
            "10",
            "13"
        ]);
        expect(screen.getAllByTestId("transcript-receipt")).toHaveLength(4);
    });

    it("puts the Human's own words on the accent side and the Runtime's briefing in the middle", () => {
        renderTranscript(fixture);

        const bySeq = new Map(
            screen.getAllByTestId("transcript-bubble").map((bubble) => [bubble.dataset["seq"], bubble])
        );

        // seq 6 is an `answer` — the only Entry the User authored.
        expect(bySeq.get("6")?.dataset["side"]).toBe("right");
        // seq 1 is the `prompt`: `role: user`, but Machinery. Reading the role would put it on the right.
        expect(bySeq.get("1")?.dataset["side"]).toBe("centre");
        // seq 13 is the Assistant speaking.
        expect(bySeq.get("13")?.dataset["side"]).toBe("left");
    });

    it("shows the Assistant's own question as speech rather than as a Receipt", () => {
        renderTranscript(fixture);

        const bySeq = new Map(
            screen.getAllByTestId("transcript-bubble").map((bubble) => [bubble.dataset["seq"], bubble])
        );

        expect(bySeq.get("4")?.dataset["kind"]).toBe("tool-intent");
        expect(bySeq.get("4")).toHaveTextContent("Asking the User what they want done");
    });

    it("writes a separator above every cluster, saying when it began", () => {
        renderTranscript(
            conversationWith([
                { Seq: 1, At: "2026-07-23T15:09:00", Role: "assistant", Kind: "assistant", Text: "Morning." },
                { Seq: 2, At: "2026-07-24T09:00:00", Role: "user", Kind: "answer", Text: "Afternoon." }
            ])
        );

        expect(screen.getAllByTestId("transcript-separator").map((label) => label.textContent)).toEqual([
            "Thu 23 Jul at 15:09",
            "Fri 24 Jul at 09:00"
        ]);
    });

    it("renders a Conversation with no Entries as a header and nothing else", () => {
        renderTranscript(conversationWith([]));

        expect(screen.getByTestId("transcript-header")).toBeInTheDocument();
        expect(screen.queryAllByTestId("transcript-bubble")).toHaveLength(0);
        expect(screen.queryAllByTestId("transcript-separator")).toHaveLength(0);
    });

    it("is a box of the modelled height that scrolls on its own", () => {
        render(
            <Frame>
                <ConversationTranscript document={fixture} height={640} />
            </Frame>
        );

        expect(screen.getByTestId("conversation-transcript")).toHaveStyle({ height: "640px", overflowY: "auto" });
    });
});
