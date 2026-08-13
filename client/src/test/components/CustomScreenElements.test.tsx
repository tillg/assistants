import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import type { FormModel, FormModelMap } from "@com.mgmtp.a12.formengine/formengine-core";
import { LoggerFactory } from "@com.mgmtp.a12.utils/utils-logging";

import { CustomScreenElements } from "../../components/CustomScreenElements";

import fixture from "../fixtures/conversation.json";

import { Frame, serveDocuments } from "./conversation/harness";

const logger = LoggerFactory.getLogger("PT/CustomScreenElements");

/** A modelled placeholder, with whatever annotations the case is about. */
function element(annotations: FormModel.CustomScreenElement["annotations"], id = "custom_transcript") {
    return {
        type: "CustomScreenElement",
        id,
        name: "ConversationTranscript",
        height: 640,
        annotations
    } as FormModel.CustomScreenElement;
}

/** Only the slice of the render configuration a custom screen element reads: the document. */
function configFor(document: object): FormModelMap.RenderConfiguration {
    return { renderOptions: { state: { data: { document } } } } as unknown as FormModelMap.RenderConfiguration;
}

function renderElement(modelElement: FormModel.CustomScreenElement, document: object = fixture) {
    return render(
        <Frame>
            <CustomScreenElements modelElement={modelElement} config={configFor(document)} />
        </Frame>
    );
}

describe("CustomScreenElements", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("renders the Transcript for the widget that asks for one, over the document the form holds", () => {
        renderElement(element([{ name: "widget", value: "conversation-transcript" }]));

        expect(screen.getByTestId("conversation-transcript")).toBeInTheDocument();
        expect(screen.getAllByTestId("transcript-bubble")).toHaveLength(6);
    });

    it("hands the modelled height to the box it renders", () => {
        renderElement(element([{ name: "widget", value: "conversation-transcript" }]));

        expect(screen.getByTestId("conversation-transcript")).toHaveStyle({ height: "640px" });
    });

    it("reads the named Conversation when the form it sits on holds an Open Question instead", async () => {
        const server = serveDocuments({
            "Conversation_DM/80d22bcd": {
                Conversation: { AssistantKey: "accountant", Title: "Invoice 2026-118", Entries: [] }
            }
        });

        renderElement(element([{ name: "widget", value: "conversation-transcript" }]), {
            // One `widget` value, two documents: the element renders the Conversation the form holds, or
            // the one its document names. The question form's element carries no `exposes` for exactly
            // this reason — the Entries it shows are not its own document's.
            OpenQuestion: { AssistantKey: "accountant", Kind: "approval", ConversationId: "80d22bcd" }
        });

        await waitFor(() => expect(screen.getByTestId("transcript-header")).toHaveTextContent("Invoice 2026-118"));
        expect(server.asked[0]?.params.docRef).toBe("Conversation_DM/80d22bcd");
    });

    it("shows an empty thread, not a missing conversation, for a document the engine has not filled in", () => {
        const server = serveDocuments({});

        renderElement(element([{ name: "widget", value: "conversation-transcript" }]), {});

        expect(screen.getByTestId("conversation-transcript")).toBeInTheDocument();
        expect(screen.queryByTestId("transcript-message")).toBeNull();
        expect(server.asked).toHaveLength(0);
    });

    it("renders nothing, and says so once, for a widget nobody wrote", () => {
        const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

        const { unmount } = renderElement(element([{ name: "widget", value: "hologram" }], "custom_unknown"));
        unmount();
        renderElement(element([{ name: "widget", value: "hologram" }], "custom_unknown"));

        expect(screen.queryByTestId("conversation-transcript")).toBeNull();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.join(" ")).toContain("hologram");
    });

    it("renders nothing, and says so once, for a placeholder no developer filled in", () => {
        const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

        renderElement(element(undefined, "custom_unannotated"));

        expect(screen.queryByTestId("conversation-transcript")).toBeNull();
        expect(warn).toHaveBeenCalledTimes(1);
    });
});
