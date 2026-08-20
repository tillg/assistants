import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import { LoggerFactory } from "@com.mgmtp.a12.utils/utils-logging";
import { resetThingByIdCache } from "../../../components/conversation/useThingById";

import { PendingQuestion } from "../../../components/conversation/PendingQuestion";
import { ICONS } from "../../../components/icons";
import { OPEN_FOREIGN_FORM } from "../../../sagas/openForeignForm";

import { Frame, recordingStore, serveDocuments } from "./harness";

/** The Open Question a Conversation's `currentQuestionId` names, as the store returns it. */
const QUESTION = {
    OpenQuestion: {
        AssistantKey: "accountant",
        Kind: "approval",
        ConversationId: "80d22bcd",
        Prompt: "**Approval needed.** Book invoice 2026-118 to 6815?",
        Options: [
            { OptionValue: "yes", OptionLabel: "Book it" },
            { OptionValue: "no", OptionLabel: "Leave it" }
        ]
    }
};

function renderPending(questionId: string, store = recordingStore()) {
    render(
        <Frame store={store.store}>
            <PendingQuestion questionId={questionId} />
        </Frame>
    );
    return store;
}

describe("PendingQuestion", () => {
    beforeEach(() => {
        resetThingByIdCache();
        vi.spyOn(LoggerFactory.getLogger("PT/useThingById"), "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("carries the question's own words, which is the case the whole change exists for", async () => {
        serveDocuments({ "OpenQuestion_DM/45e95914": QUESTION });

        renderPending("45e95914");

        await waitFor(() => expect(screen.getByTestId("pending-question")).toBeInTheDocument());
        expect(screen.getByTestId("pending-question")).toHaveTextContent("Approval needed.");
        expect(screen.getByTestId("pending-question")).toHaveTextContent("Book invoice 2026-118 to 6815?");
    });

    it("lists the options the question offers", async () => {
        serveDocuments({ "OpenQuestion_DM/45e95914": QUESTION });

        renderPending("45e95914");

        await waitFor(() => expect(screen.getByTestId("pending-question-options")).toBeInTheDocument());
        const options = screen.getByTestId("pending-question-options");
        expect(options).toHaveTextContent("Book it");
        expect(options).toHaveTextContent("Leave it");
    });

    it("asks for the question's own form, with the Conversations list beside it", async () => {
        serveDocuments({ "OpenQuestion_DM/45e95914": QUESTION });

        const store = renderPending("45e95914");
        await waitFor(() => expect(screen.getByTestId("pending-question-answer")).toBeInTheDocument());
        screen.getByTestId("pending-question-answer").click();

        expect(store.actions).toEqual([
            {
                type: OPEN_FOREIGN_FORM,
                payload: {
                    module: "OpenQuestion",
                    documentModel: "OpenQuestion_DM",
                    thingId: "45e95914",
                    // The User came from Conversations and answering is one step inside that act, so
                    // `Cancel` returns them to the list rather than to a second inbox of questions.
                    masterModule: "Conversation"
                }
            }
        ]);
    });

    it("says one line, and offers no Answer, when the question cannot be read", async () => {
        serveDocuments({});

        renderPending("45e95914");

        await waitFor(() => expect(screen.getByTestId("transcript-message")).toBeInTheDocument());
        expect(screen.queryByTestId("pending-question")).toBeNull();
        expect(screen.queryByTestId("pending-question-answer")).toBeNull();
        expect(screen.getAllByTestId("transcript-message")).toHaveLength(1);
    });

    it("keeps the glyph on that line out of the accessible text, whose words already say it", async () => {
        serveDocuments({});

        renderPending("45e95914");

        await waitFor(() => expect(screen.getByTestId("transcript-message")).toBeInTheDocument());
        const message = screen.getByTestId("transcript-message");
        expect(message).toHaveTextContent("A question is pending, but it could not be read.");
        expect(message.querySelector("[aria-hidden='true']")).toHaveTextContent(ICONS.blocked);
    });
});
