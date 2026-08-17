import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { TranscriptHeader } from "../../../components/conversation/TranscriptHeader";
import { readEntries } from "../../../components/conversation/entries";
import { ICONS } from "../../../components/icons";
import { OPEN_FOREIGN_FORM } from "../../../sagas/openForeignForm";

import { Frame, recordingStore } from "./harness";

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

describe("TranscriptHeader", () => {
    it("names the Assistant and what the Conversation is called", () => {
        renderHeader(conversation({}));

        const header = screen.getByTestId("transcript-header");
        expect(header).toHaveTextContent("🤖");
        expect(header).toHaveTextContent("accountant");
        expect(header).toHaveTextContent("Invoice 2026-118");
    });

    it("says how far through its turns the Conversation is", () => {
        renderHeader(conversation({}));

        expect(screen.getByTestId("transcript-state")).toHaveTextContent("turn 5/20");
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

    it("links to the subject Thing, and asks the saga to open it beside its own list", () => {
        const store = renderHeader(
            conversation({ SubjectModel: "Invoice_DM", SubjectThingId: "a3f9c1de-0000-4000-8000-000000000001" })
        );

        expect(screen.getByTestId("transcript-about-link")).toHaveTextContent("Invoice");
        fireEvent.click(screen.getByTestId("transcript-about-link"));

        expect(store.actions).toEqual([
            {
                type: OPEN_FOREIGN_FORM,
                payload: {
                    module: "Invoice",
                    documentModel: "Invoice_DM",
                    thingId: "a3f9c1de-0000-4000-8000-000000000001",
                    masterModule: "Invoice"
                }
            }
        ]);
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

    it("links to the Conversation that called this one", () => {
        const store = renderHeader(conversation({ ParentConversationId: "80d22bcd-4f19-4f8f-bbb7-8ab30e666f9a" }));

        fireEvent.click(screen.getByTestId("transcript-parent-link"));

        expect(store.actions).toEqual([
            {
                type: OPEN_FOREIGN_FORM,
                payload: {
                    module: "Conversation",
                    documentModel: "Conversation_DM",
                    thingId: "80d22bcd-4f19-4f8f-bbb7-8ab30e666f9a",
                    masterModule: "Conversation"
                }
            }
        ]);
    });

    it("has no parent link when nothing called this Conversation", () => {
        renderHeader(conversation({}));

        expect(screen.getByTestId("transcript-who")).toHaveTextContent("accountant");
        expect(screen.queryByTestId("transcript-parent-link")).toBeNull();
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
