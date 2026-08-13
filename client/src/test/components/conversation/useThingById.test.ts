import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

import { LoggerFactory } from "@com.mgmtp.a12.utils/utils-logging";

import { useThingById } from "../../../components/conversation/useThingById";

import { serveRpc, type RpcRequest } from "./harness";

/**
 * The hook is exercised through the platform's real dispatcher; only the HTTP boundary is replaced (see
 * `harness.tsx`). So the JSON-RPC framing, the id matching and the error handling under test are the
 * shipped ones, and what a test controls is what the server said — which is the only way "a rejected
 * request" can be a case at all.
 */

/** Every request the installed server was handed, as the dispatcher framed it. */
let sent: RpcRequest[] = [];

function install(reply: (request: RpcRequest) => unknown, ok = true): void {
    sent = serveRpc(reply, ok).asked;
}

/** A GET_DOCUMENT response the server would send for a Thing that is there. */
function found(request: RpcRequest, document: object): object {
    return {
        jsonrpc: "2.0",
        id: request.id,
        result: { docRef: "OpenQuestion_DM/45e95914", documentModelName: "OpenQuestion_DM", document }
    };
}

const QUESTION = { OpenQuestion: { Prompt: "Book it?" } };

describe("useThingById", () => {
    beforeEach(() => {
        sent = [];
        vi.spyOn(LoggerFactory.getLogger("PT/useThingById"), "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("composes the docRef from the Model and the bare ThingID, because no Thing carries one", async () => {
        install((request) => found(request, QUESTION));

        const { result } = renderHook(() => useThingById("OpenQuestion_DM", "45e95914"));

        await waitFor(() => expect(result.current.state).toBe("ready"));
        expect(sent).toHaveLength(1);
        expect(sent[0]?.method).toBe("GET_DOCUMENT");
        expect(sent[0]?.params.docRef).toBe("OpenQuestion_DM/45e95914");
    });

    it("hands back the document it read", async () => {
        install((request) => found(request, QUESTION));

        const { result } = renderHook(() => useThingById("OpenQuestion_DM", "45e95914"));

        await waitFor(() => expect(result.current.state).toBe("ready"));
        expect(result.current.state === "ready" && result.current.document).toEqual(QUESTION);
    });

    it("has nothing to show, and asks for nothing, when there is no id", () => {
        install((request) => found(request, QUESTION));

        const { result } = renderHook(() => useThingById("OpenQuestion_DM", ""));

        expect(result.current.state).toBe("nothing");
        expect(sent).toHaveLength(0);
    });

    it("has nothing to show, and does not throw, when the request is rejected", async () => {
        install((request) => ({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32603, message: "No document entry found for docRef", data: {} }
        }));

        const { result } = renderHook(() => useThingById("OpenQuestion_DM", "45e95914"));

        await waitFor(() => expect(result.current.state).toBe("nothing"));
    });

    it("has nothing to show, and does not throw, when the transport fails", async () => {
        install((request) => found(request, QUESTION), false);

        const { result } = renderHook(() => useThingById("OpenQuestion_DM", "45e95914"));

        await waitFor(() => expect(result.current.state).toBe("nothing"));
    });

    it("has nothing to show when the document is not there", async () => {
        install((request) => ({
            jsonrpc: "2.0",
            id: request.id,
            result: { docRef: "OpenQuestion_DM/45e95914", documentModelName: "OpenQuestion_DM" }
        }));

        const { result } = renderHook(() => useThingById("OpenQuestion_DM", "45e95914"));

        await waitFor(() => expect(result.current.state).toBe("nothing"));
    });

    it("reads again when the id changes, and only then", async () => {
        install((request) => found(request, QUESTION));

        const { result, rerender } = renderHook(({ id }: { id: string }) => useThingById("OpenQuestion_DM", id), {
            initialProps: { id: "45e95914" }
        });
        await waitFor(() => expect(result.current.state).toBe("ready"));

        rerender({ id: "45e95914" });
        expect(sent).toHaveLength(1);

        rerender({ id: "7c0b1a22" });
        await waitFor(() => expect(sent).toHaveLength(2));
        expect(sent[1]?.params.docRef).toBe("OpenQuestion_DM/7c0b1a22");
    });
});
