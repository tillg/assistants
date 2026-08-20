import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { LoggerFactory } from "@com.mgmtp.a12.utils/utils-logging";

import { TranscriptHeader } from "../../../components/conversation/TranscriptHeader";
import { readEntries } from "../../../components/conversation/entries";
import { ICONS } from "../../../components/icons";

import { Frame, recordingStore, serveRpc } from "./harness";

/** The head fields of a Conversation, with only what a case is about filled in. */
function conversation(fields: Record<string, unknown>, entries: readonly object[] = []): object {
    return {
        Conversation: {
            AssistantKey: "accountant",
            Title: "Invoice 2026-118",
            Status: "running",
            WaitingFor: "",
            FinishReason: "",
            TurnCount: 5,
            MaxTurns: 20,
            SubjectModel: "",
            SubjectThingId: "",
            ScheduledFor: "",
            ParentConversationId: "",
            Entries: entries,
            ...fields
        }
    };
}

function renderHeader(document: object, store = recordingStore()) {
    render(
        <Frame store={store.store}>
            <TranscriptHeader document={document} entries={readEntries(document)} />
        </Frame>
    );
    return store;
}

/** Answers the badge's key→Name query so the Assistant renders by Name, not by its raw key. */
function serveAssistant(key: string, name: string): void {
    serveRpc((request) => ({
        jsonrpc: "2.0",
        id: request.id,
        result: {
            page: { pageNumber: 0, pageSize: 1 },
            fullSize: 1,
            entries: [
                { type: "ROOT", docRef: `Assistant_DM/${key}`, document: { Assistant: { Key: key, Name: name } } }
            ],
            links: [],
            otherResults: {}
        }
    }));
}

describe("TranscriptHeader", () => {
    beforeEach(() => {
        vi.spyOn(LoggerFactory.getLogger("PT/useAssistantName"), "warn").mockImplementation(() => {});
        // A subject ThingLink reads its document; the single-reply server below is shaped for the badge
        // query, so that read fails soft to a short id — which is fine, and this keeps its warning quiet.
        vi.spyOn(LoggerFactory.getLogger("PT/useThingById"), "warn").mockImplementation(() => {});
        // Every header names its Assistant, so every case resolves the default key to a Name.
        serveAssistant("accountant", "Ada Ledger");
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("names the Assistant by Name and what the Conversation is called", async () => {
        renderHeader(conversation({}));

        const header = screen.getByTestId("transcript-header");
        expect(header).toHaveTextContent("🤖");
        await waitFor(() => expect(screen.getByTestId("transcript-who")).toHaveTextContent("Ada Ledger"));
        expect(header).toHaveTextContent("Invoice 2026-118");
    });

    it("leads with the Conversation's Title, bold, on its own line", () => {
        renderHeader(conversation({}));

        expect(screen.getByTestId("transcript-title")).toHaveTextContent("Invoice 2026-118");
    });

    it("omits the Title line and leads with the Assistant when the Conversation has no Title yet", async () => {
        renderHeader(conversation({ Title: "" }));

        // A freshly-born Conversation has no Title; the band must not show an empty bold gap.
        expect(screen.queryByTestId("transcript-title")).toBeNull();
        await waitFor(() => expect(screen.getByTestId("transcript-who")).toHaveTextContent("Ada Ledger"));
    });

    it("says how far through its turns the Conversation is", () => {
        renderHeader(conversation({}));

        expect(screen.getByTestId("transcript-state")).toHaveTextContent("turn 5/20");
    });

    it("renders its own visible strings in the User's language", () => {
        // BUG-14: the transcript's words were literals and stayed English when the User switched to
        // German. They now come from the resource bundle, off the locale the LocaleSelect writes.
        localStorage.setItem("locale", "de");
        try {
            renderHeader(
                conversation({
                    Status: "waiting",
                    WaitingFor: "user",
                    CurrentQuestionId: "x",
                    ParentConversationId: "5b7b9db7"
                })
            );
            expect(screen.getByTestId("transcript-state")).toHaveTextContent("wartet auf Sie");
            expect(screen.getByTestId("transcript-state")).toHaveTextContent("Runde 5/20");
            expect(screen.getByTestId("transcript-header")).toHaveTextContent("aufgerufen von");
        } finally {
            localStorage.removeItem("locale");
        }
    });

    it("shows the marker when the Conversation is waiting on the User", () => {
        renderHeader(conversation({ Status: "waiting", WaitingFor: "user", CurrentQuestionId: "45e95914" }));

        expect(screen.getByTestId("transcript-blocked")).toHaveTextContent("🛑");
    });

    it("hides the marker's glyph from a reader who is read to, as every other glyph is hidden", () => {
        renderHeader(conversation({ Status: "waiting", WaitingFor: "user", CurrentQuestionId: "45e95914" }));

        // The words already say it. Left in the accessible text the glyph is announced in front of
        // them — "stop sign waiting for you" — which is noise, not information.
        const blocked = screen.getByTestId("transcript-blocked");
        expect(blocked).toHaveTextContent("waiting for you");
        expect(blocked.querySelector("[aria-hidden='true']")).toHaveTextContent(ICONS.blocked);
    });

    it("shows no marker when the Conversation is waiting on something else", () => {
        renderHeader(conversation({ Status: "waiting", WaitingFor: "tool" }));

        expect(screen.getByTestId("transcript-state")).toHaveTextContent("turn 5/20");
        expect(screen.queryByTestId("transcript-blocked")).toBeNull();
    });

    it("says why the Conversation ended, once it has", () => {
        renderHeader(conversation({ Status: "done", FinishReason: "answered" }));

        expect(screen.getByTestId("transcript-state")).toHaveTextContent("answered");
    });

    it("names the subject Thing with its Model in brackets and opens it in a read-only popup", async () => {
        renderHeader(
            conversation({ SubjectModel: "Invoice_DM", SubjectThingId: "a3f9c1de-0000-4000-8000-000000000001" })
        );

        const link = screen.getByTestId("thing-link");
        expect(link).toHaveTextContent("about");
        expect(link).toHaveTextContent("(Invoice)");

        fireEvent.click(link);

        // Opens a read-only summary of the subject in place — a reading, not a navigation away. (The
        // subject document is not served by this header harness, so the summary shows the Model heading
        // and fails soft in its body — enough to prove the popup opened on the right Thing.)
        await waitFor(() => expect(screen.getByTestId("thing-summary-title")).toHaveTextContent("(Invoice)"));
    });

    it("offers text rather than a link when the subject's Model has no module", () => {
        renderHeader(conversation({ SubjectModel: "Booking_DM", SubjectThingId: "a3f9c1de" }));

        expect(screen.queryByTestId("transcript-about-link")).toBeNull();
        expect(screen.getByTestId("transcript-about")).toHaveTextContent("Booking_DM");
    });

    it("says when a Conversation born of a Schedule was due, since it has no subject", () => {
        renderHeader(conversation({ ScheduledFor: "2026-08-20T09:00:00" }));

        expect(screen.queryByTestId("transcript-about-link")).toBeNull();
        expect(screen.getByTestId("transcript-about")).toHaveTextContent("scheduled for Thu 20 Aug at 09:00");
    });

    it("links to the Conversation that called this one, opening it in a popup", async () => {
        renderHeader(conversation({ ParentConversationId: "80d22bcd-4f19-4f8f-bbb7-8ab30e666f9a" }));

        const link = screen.getByTestId("thing-link");
        expect(link).toHaveTextContent("called by");
        expect(link).toHaveTextContent("(Conversation)");

        fireEvent.click(link);

        await waitFor(() => expect(screen.getByTestId("thing-summary-title")).toHaveTextContent("(Conversation)"));
    });

    it("has no Thing link when nothing is a subject and nothing called this Conversation", async () => {
        renderHeader(conversation({}));

        await waitFor(() => expect(screen.getByTestId("transcript-who")).toHaveTextContent("Ada Ledger"));
        expect(screen.queryByTestId("thing-link")).toBeNull();
    });

    it("adds up what was recorded and says it is a lower bound", () => {
        renderHeader(
            conversation({}, [
                { Seq: 1, At: "2026-08-13T18:42:19", Kind: "assistant", Role: "assistant" },
                {
                    Seq: 2,
                    At: "2026-08-13T18:42:25",
                    Kind: "assistant",
                    Role: "assistant",
                    PromptTokens: 100,
                    CompletionTokens: 20
                }
            ])
        );

        expect(screen.getByTestId("transcript-cost").textContent).toMatch(/^≥ 120 tokens/);
    });
});
