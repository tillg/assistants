import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import { LoggerFactory } from "@com.mgmtp.a12.utils/utils-logging";

import { resetThingByIdCache } from "../../../components/conversation/useThingById";
import { QuestionContext } from "../../../components/conversation/QuestionContext";

import { Frame, serveDocuments } from "./harness";

/**
 * The Answer Surface's half of seam 4. Here the fetched Conversation is not an addition to the screen,
 * it *is* the screen's context — so the case that matters most is the one where the fetch fails, and the
 * thing that must never break is that the question stays answerable.
 */

const QUESTION = {
    OpenQuestion: {
        AssistantKey: "accountant",
        Kind: "approval",
        ConversationId: "80d22bcd",
        Prompt: "**Approval needed.** Book invoice 2026-118 to 6815?"
    }
};

const CONVERSATION = {
    Conversation: {
        AssistantKey: "accountant",
        Title: "Invoice 2026-118",
        Status: "waiting",
        WaitingFor: "user",
        TurnCount: 5,
        MaxTurns: 20,
        CurrentQuestionId: "45e95914",
        Entries: [{ Seq: 1, At: "2026-07-23T15:09:00", Role: "assistant", Kind: "assistant", Text: "Checking." }]
    }
};

/** Stands for what the form models beneath the element: the prompt and the answer controls. */
function renderContext(document: object) {
    return render(
        <Frame>
            <QuestionContext document={document} height={480} />
            <textarea data-role="answer-controls" defaultValue="" />
        </Frame>
    );
}

describe("QuestionContext", () => {
    beforeEach(() => {
        resetThingByIdCache();
        vi.spyOn(LoggerFactory.getLogger("PT/useThingById"), "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("shows the Conversation the question came from, header and all", async () => {
        serveDocuments({ "Conversation_DM/80d22bcd": CONVERSATION });

        renderContext(QUESTION);

        await waitFor(() => expect(screen.getByTestId("conversation-transcript")).toBeInTheDocument());
        const header = screen.getByTestId("transcript-header");
        expect(header).toHaveTextContent("accountant");
        expect(header).toHaveTextContent("Invoice 2026-118");
        expect(screen.getAllByTestId("transcript-bubble")).toHaveLength(1);
    });

    it("composes the docRef from the Model and the bare ConversationId the question holds", async () => {
        const server = serveDocuments({ "Conversation_DM/80d22bcd": CONVERSATION });

        renderContext(QUESTION);

        await waitFor(() => expect(server.asked).toHaveLength(1));
        expect(server.asked[0]?.params.docRef).toBe("Conversation_DM/80d22bcd");
    });

    it("shows no Pending Question Bubble: the answer controls beneath it are that Bubble", async () => {
        serveDocuments({ "Conversation_DM/80d22bcd": CONVERSATION });

        renderContext(QUESTION);

        await waitFor(() => expect(screen.getByTestId("conversation-transcript")).toBeInTheDocument());
        expect(screen.queryByTestId("pending-question")).toBeNull();
    });

    it("falls back to the question's own Assistant and kind, beside one message line", async () => {
        serveDocuments({});

        renderContext(QUESTION);

        await waitFor(() => expect(screen.getByTestId("transcript-message")).toBeInTheDocument());
        const header = screen.getByTestId("transcript-header");
        expect(header).toHaveTextContent("accountant");
        expect(header).toHaveTextContent("approval");
        expect(screen.getAllByTestId("transcript-message")).toHaveLength(1);
    });

    it("leaves the screen answerable, which is the only thing that must never break", async () => {
        serveDocuments({});

        renderContext(QUESTION);

        await waitFor(() => expect(screen.getByTestId("transcript-message")).toBeInTheDocument());
        expect(screen.getByTestId("answer-controls")).toBeInTheDocument();
    });

    it("asks for nothing, and still says who and what, when the question names no Conversation", async () => {
        const server = serveDocuments({});

        renderContext({ OpenQuestion: { AssistantKey: "accountant", Kind: "choice", ConversationId: "" } });

        await waitFor(() => expect(screen.getByTestId("transcript-message")).toBeInTheDocument());
        // No Conversation to read — the badge may still resolve the Assistant's Name, but no document
        // is fetched for a thread that names none.
        expect(server.asked.filter((request) => request.method === "GET_DOCUMENT")).toHaveLength(0);
        expect(screen.getByTestId("transcript-header")).toHaveTextContent("choice");
        expect(screen.getByTestId("answer-controls")).toBeInTheDocument();
    });
});
