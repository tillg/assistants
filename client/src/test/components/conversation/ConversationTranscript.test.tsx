import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import { LoggerFactory } from "@com.mgmtp.a12.utils/utils-logging";

import { ConversationTranscript } from "../../../components/conversation/ConversationTranscript";
import fixture from "../../fixtures/conversation.json";

import { Frame, serveDocuments } from "./harness";

/** A Conversation document with just the Entries a case is about. */
function conversationWith(entries: readonly object[]): object {
    return { Conversation: { AssistantKey: "accountant", Title: "Accountant", Entries: entries } };
}

/** A blocked Conversation: two Entries, and the id of the question it is waiting on. */
const BLOCKED = {
    Conversation: {
        AssistantKey: "accountant",
        Title: "Invoice 2026-118",
        Status: "waiting",
        WaitingFor: "user",
        CurrentQuestionId: "45e95914",
        Entries: [
            { Seq: 1, At: "2026-07-23T15:09:00", Role: "assistant", Kind: "assistant", Text: "Checking." },
            { Seq: 2, At: "2026-07-23T15:09:04", Role: "system", Kind: "approval-request" }
        ]
    }
};

/** The question `BLOCKED` is waiting on, as the store returns it. */
const QUESTION = {
    OpenQuestion: {
        Kind: "approval",
        Prompt: "**Approval needed.** Book invoice 2026-118 to 6815?",
        Options: [{ OptionValue: "yes", OptionLabel: "Book it" }]
    }
};

function renderTranscript(document: object) {
    return render(
        <Frame>
            <ConversationTranscript document={document} />
        </Frame>
    );
}

describe("ConversationTranscript", () => {
    beforeEach(() => {
        vi.spyOn(LoggerFactory.getLogger("PT/useThingById"), "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

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

    it("gives every Bubble its own key, even where the document carried no Seq", () => {
        const complaints = vi.spyOn(console, "error").mockImplementation(() => {});

        renderTranscript(
            conversationWith([
                { At: "2026-07-23T15:09:00", Role: "assistant", Kind: "note", Text: "First." },
                { At: "2026-07-23T15:09:01", Role: "assistant", Kind: "note", Text: "Second." }
            ])
        );

        // Both Entries read as `seq: 0`, so a key built from `seq` collided. That is not a cosmetic
        // warning: a Receipt holds open/closed in `useState`, and React reconciling the wrong child
        // opens the wrong Receipt.
        expect(complaints.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("same key"))).toEqual(
            []
        );
        expect(screen.getAllByTestId("transcript-bubble")).toHaveLength(2);
    });

    it("is reachable by keyboard, because it owns the scroll a reader has to move", () => {
        renderTranscript(fixture);

        // Nothing between the Bubbles takes focus, so without a stop of its own a reader who does not
        // use a mouse sees the first screenful and no more (WCAG 2.1.1).
        const box = screen.getByTestId("conversation-transcript");
        expect(box).toHaveAttribute("tabindex", "0");
        expect(box).toHaveAccessibleName("Conversation transcript");
    });

    it("is a box of the modelled height that scrolls on its own", () => {
        render(
            <Frame>
                <ConversationTranscript document={fixture} height={640} />
            </Frame>
        );

        expect(screen.getByTestId("conversation-transcript")).toHaveStyle({ height: "640px", overflowY: "auto" });
    });

    it("ends in the Pending Question Bubble, carrying words the Entries do not have", async () => {
        serveDocuments({ "OpenQuestion_DM/45e95914": QUESTION });

        renderTranscript(BLOCKED);

        await waitFor(() => expect(screen.getByTestId("pending-question")).toBeInTheDocument());
        const pending = screen.getByTestId("pending-question");
        // The `approval-request` Entry carries no text at all; these words come from the question.
        expect(pending).toHaveTextContent("Book invoice 2026-118 to 6815?");
        expect(pending).toHaveTextContent("Book it");
        expect(screen.getByTestId("pending-question-answer")).toBeInTheDocument();

        const last = screen.getAllByTestId("transcript-bubble").at(-1)!;
        expect(last.compareDocumentPosition(pending) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("shows no such Bubble when nothing is pending, and asks for nothing", () => {
        const server = serveDocuments({ "OpenQuestion_DM/45e95914": QUESTION });

        renderTranscript(fixture);

        expect(screen.getAllByTestId("transcript-bubble")).toHaveLength(6);
        expect(screen.queryByTestId("pending-question")).toBeNull();
        expect(screen.queryByTestId("transcript-message")).toBeNull();
        expect(server.asked).toHaveLength(0);
    });

    it("leaves the thread standing when the pending question cannot be read", async () => {
        serveDocuments({});

        renderTranscript(BLOCKED);

        await waitFor(() => expect(screen.getByTestId("transcript-message")).toBeInTheDocument());
        expect(screen.getAllByTestId("transcript-message")).toHaveLength(1);
        expect(screen.getAllByTestId("transcript-bubble")).toHaveLength(2);
        expect(screen.getByTestId("transcript-header")).toBeInTheDocument();
    });

    it("shows no Bubble on the Answer Surface, where the answer controls are that Bubble", async () => {
        const server = serveDocuments({ "OpenQuestion_DM/45e95914": QUESTION });

        render(
            <Frame>
                <ConversationTranscript document={BLOCKED} showPendingQuestion={false} />
            </Frame>
        );

        await waitFor(() => expect(screen.getAllByTestId("transcript-bubble")).toHaveLength(2));
        expect(screen.queryByTestId("pending-question")).toBeNull();
        expect(server.asked).toHaveLength(0);
    });
});
