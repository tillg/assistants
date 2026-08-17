import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

import { ConnectorLocator, type RestRequestPayload, type ServerConnector } from "@com.mgmtp.a12.utils/utils-connector";
import { LoggerFactory } from "@com.mgmtp.a12.utils/utils-logging";

import { useThingCounts, type CountQuery } from "../../../components/dashboard/useThingCounts";

/**
 * As `useThingById.test.ts` does, the hook is exercised through the platform's real dispatcher and only
 * the HTTP boundary is replaced — so the batching and the id matching under test are the shipped ones.
 *
 * The server is installed here rather than taken from `conversation/harness.tsx` because this suite has
 * to answer a **batch**: it counts round trips, and it hands the replies back in reverse, which is the
 * only way "matched by id and not by position" can be a test at all.
 */

/** One JSON-RPC request, as the dispatcher frames it on the wire. */
interface RpcRequest {
    readonly id: unknown;
    readonly method: string;
    readonly params: { readonly query: Record<string, unknown> };
}

/** Every request the installed server was handed. */
let sent: RpcRequest[] = [];

/** How many times the dispatcher went to the wire. Three counts in one call is the claim. */
let batches = 0;

interface Serving {
    /** Answers one request. */
    readonly reply?: (request: RpcRequest) => unknown;
    /** Hands the batch's replies back in reverse, as a batching server is free to do. */
    readonly reversed?: boolean;
    /** `false` is a transport failure, which the dispatcher treats differently from a rejection. */
    readonly ok?: boolean;
}

function install({ reply = (request) => counted(request.id, 1), reversed = false, ok = true }: Serving = {}): void {
    sent = [];
    batches = 0;
    ConnectorLocator.createInstance({
        fetchData: (payload: RestRequestPayload) => {
            const requests = JSON.parse(String(payload.body)) as RpcRequest[];
            sent.push(...requests);
            batches++;
            const replies = requests.map(reply);
            return Promise.resolve({
                ok,
                statusText: "Boom",
                json: () => Promise.resolve(reversed ? [...replies].reverse() : replies)
            } as unknown as Response);
        }
    } as unknown as ServerConnector);
}

/**
 * A QUERY response, in the shape the platform's own type guard insists on: `page`, `fullSize`,
 * `entries`, `links` and `otherResults` all have to be there or `Dispatcher.rpc` rejects the batch. Only
 * `fullSize` is what this hook reads; the rest is here because a fake that the shipped guard would
 * refuse is a fake that proves nothing.
 */
function counted(id: unknown, fullSize: number, entries: unknown[] = []): object {
    return {
        jsonrpc: "2.0",
        id,
        result: { page: { pageNumber: 0, pageSize: 0 }, fullSize, entries, links: [], otherResults: {} }
    };
}

const THREE: readonly CountQuery[] = [
    {
        key: "running",
        model: "Conversation_DM",
        constraint: { operator: "exact_match", field: "/Conversation/Status", value: "running" }
    },
    {
        key: "waitingOnUser",
        model: "Conversation_DM",
        constraint: { operator: "exact_match", field: "/Conversation/WaitingFor", value: "user" }
    },
    { key: "total", model: "Conversation_DM" }
];

/** The query a request carries, which is where its own constraint — and so its identity — lives. */
function queryOf(request: RpcRequest): Record<string, unknown> {
    return request.params.query;
}

/** Answers each of `THREE` with a number of its own, keyed off the caller's constraint and not the id. */
function byConstraint(request: RpcRequest): object {
    const constraint = queryOf(request)["constraint"] as { value?: string } | undefined;
    const fullSize = constraint === undefined ? 11 : constraint.value === "running" ? 7 : 4;
    return counted(request.id, fullSize);
}

describe("useThingCounts", () => {
    beforeEach(() => {
        vi.spyOn(LoggerFactory.getLogger("PT/useThingCounts"), "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("puts N counts in one round trip, so a Tile is never half loaded", async () => {
        install();

        const { result } = renderHook(() => useThingCounts(THREE));

        await waitFor(() => expect(result.current.state).toBe("ready"));
        expect(batches).toBe(1);
        expect(sent).toHaveLength(3);
        expect(sent.every((request) => request.method === "QUERY")).toBe(true);
    });

    it("matches results to queries by response id, not by array position", async () => {
        // A batch response is a JSON-RPC array whose order the protocol does not promise. Reversed, a
        // hook that read by position would swap two of a Tile's three numbers and say nothing.
        install({ reply: byConstraint, reversed: true });

        const { result } = renderHook(() => useThingCounts(THREE));

        await waitFor(() => expect(result.current.state).toBe("ready"));
        expect(result.current.state === "ready" && result.current.counts).toEqual({
            running: 7,
            waitingOnUser: 4,
            total: 11
        });
    });

    it("reads fullSize and discards entries, so no count can become a second copy of a Thing", async () => {
        install({ reply: (request) => counted(request.id, 42, [{ Conversation: { Title: "never kept" } }]) });

        const { result } = renderHook(() => useThingCounts(THREE));

        await waitFor(() => expect(result.current.state).toBe("ready"));
        expect(JSON.stringify(result.current)).not.toContain("never kept");
        expect(result.current.state === "ready" && result.current.counts["running"]).toBe(42);
    });

    it("asks for the smallest page it can, because it wants no documents at all", async () => {
        install();

        renderHook(() => useThingCounts(THREE));

        await waitFor(() => expect(sent).toHaveLength(3));
        for (const request of sent) {
            const paging = queryOf(request)["paging"] as { pageNumber: number; pageSize: number };
            expect(paging.pageSize).toBeLessThanOrEqual(1);
            expect(paging.pageNumber).toBe(0);
        }
    });

    it("omits the constraint entirely for an unconstrained count", async () => {
        install();

        renderHook(() => useThingCounts(THREE));

        await waitFor(() => expect(sent).toHaveLength(3));
        expect(sent.map(queryOf).filter((query) => "constraint" in query)).toHaveLength(2);
        expect(sent.map(queryOf).every((query) => query["targetDocumentModel"] === "Conversation_DM")).toBe(true);
    });

    it("says error, and throws nothing, when the request is rejected", async () => {
        install({
            reply: (request) => ({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "no", data: {} } })
        });

        const { result } = renderHook(() => useThingCounts(THREE));

        await waitFor(() => expect(result.current.state).toBe("error"));
    });

    it("says error, and throws nothing, when the transport fails", async () => {
        install({ ok: false });

        const { result } = renderHook(() => useThingCounts(THREE));

        await waitFor(() => expect(result.current.state).toBe("error"));
    });

    it("stamps the instant it read, because the Tile says so on screen", async () => {
        install();

        const { result } = renderHook(() => useThingCounts(THREE));

        await waitFor(() => expect(result.current.state).toBe("ready"));
        expect(result.current.state === "ready" && result.current.readAt).toBeInstanceOf(Date);
    });

    it("does not ask again when the same queries are handed back on a re-render", async () => {
        install();

        const { result, rerender } = renderHook(
            ({ queries }: { queries: readonly CountQuery[] }) => useThingCounts(queries),
            { initialProps: { queries: THREE } }
        );
        await waitFor(() => expect(result.current.state).toBe("ready"));

        // A fresh array with identical contents: a Tile builds its query list inline on every render,
        // so array identity is exactly what this hook must not depend on.
        rerender({ queries: THREE.map((query) => ({ ...query })) });
        await waitFor(() => expect(result.current.state).toBe("ready"));
        expect(batches).toBe(1);
        expect(sent).toHaveLength(3);
    });

    it("asks again when the queries actually change", async () => {
        install();

        const { result, rerender } = renderHook(
            ({ queries }: { queries: readonly CountQuery[] }) => useThingCounts(queries),
            { initialProps: { queries: THREE } }
        );
        await waitFor(() => expect(result.current.state).toBe("ready"));

        rerender({ queries: [{ key: "documents", model: "Document_DM" }] });
        await waitFor(() => expect(sent).toHaveLength(4));
        expect(batches).toBe(2);
    });
});
