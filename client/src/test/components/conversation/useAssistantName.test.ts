import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

import { ConnectorLocator, type RestRequestPayload, type ServerConnector } from "@com.mgmtp.a12.utils/utils-connector";
import { LoggerFactory } from "@com.mgmtp.a12.utils/utils-logging";

import { useAssistantName } from "../../../components/conversation/useAssistantName";

/**
 * Resolving an Assistant's key to its Name is a read that can fail, and failing is a domain fact: a
 * renamed, disabled or deleted Assistant leaves its Conversations behind. So the one invariant that
 * matters is that a key resolving to nothing is shown *as the key* — the screen degrades, never blanks.
 */

interface RpcRequest {
    readonly id: unknown;
    readonly method: string;
    readonly params: { readonly query: Record<string, unknown> };
}

let sent: RpcRequest[] = [];

/** One Assistant as the store hands it back: a document under its root. */
function entry(key: string, name: string): object {
    return { type: "ROOT", docRef: `Assistant_DM/${key}`, document: { Assistant: { Key: key, Name: name } } };
}

function install(entries: object[], ok = true): void {
    sent = [];
    ConnectorLocator.createInstance({
        fetchData: (payload: RestRequestPayload) => {
            const requests = JSON.parse(String(payload.body)) as RpcRequest[];
            sent.push(...requests);
            return Promise.resolve({
                ok,
                statusText: "Boom",
                json: () =>
                    Promise.resolve(
                        requests.map((request) => ({
                            jsonrpc: "2.0",
                            id: request.id,
                            result: {
                                page: { pageNumber: 0, pageSize: 1 },
                                fullSize: entries.length,
                                entries,
                                links: [],
                                otherResults: {}
                            }
                        }))
                    )
            } as unknown as Response);
        }
    } as unknown as ServerConnector);
}

describe("useAssistantName", () => {
    beforeEach(() => {
        vi.spyOn(LoggerFactory.getLogger("PT/useAssistantName"), "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("resolves a key to the Assistant's Name", async () => {
        install([entry("receptionist", "Receptionist")]);

        const { result } = renderHook(() => useAssistantName("receptionist"));

        await waitFor(() => expect(result.current).toBe("Receptionist"));
    });

    it("falls back to the key when the query returns no Assistant", async () => {
        install([]);

        const { result } = renderHook(() => useAssistantName("ghost-1"));

        // Nothing to resolve to: the key stands, and it never blanks on the way there.
        await waitFor(() => expect(sent).toHaveLength(1));
        expect(result.current).toBe("ghost-1");
    });

    it("falls back to the key when the read fails, and throws nothing", async () => {
        install([entry("x", "X")], false);

        const { result } = renderHook(() => useAssistantName("ghost-2"));

        await waitFor(() => expect(sent).toHaveLength(1));
        expect(result.current).toBe("ghost-2");
    });

    it("constrains an exact match on the Assistant's Key", async () => {
        install([entry("accountant", "Accountant")]);

        renderHook(() => useAssistantName("accountant"));

        await waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0]?.method).toBe("QUERY");
        expect(sent[0]?.params.query["targetDocumentModel"]).toBe("Assistant_DM");
        expect(sent[0]?.params.query["constraint"]).toEqual({
            operator: "exact_match",
            field: "/Assistant/Key",
            value: "accountant"
        });
    });

    it("resolves the empty key to itself without asking the server", async () => {
        install([entry("x", "X")]);

        const { result } = renderHook(() => useAssistantName(""));

        expect(result.current).toBe("");
        expect(sent).toHaveLength(0);
    });

    it("caches a resolved Name so a second badge for the same key does not query twice", async () => {
        install([entry("cache-me", "Cached One")]);

        const first = renderHook(() => useAssistantName("cache-me"));
        await waitFor(() => expect(first.result.current).toBe("Cached One"));
        expect(sent).toHaveLength(1);

        const second = renderHook(() => useAssistantName("cache-me"));
        expect(second.result.current).toBe("Cached One");
        expect(sent).toHaveLength(1);
    });
});
