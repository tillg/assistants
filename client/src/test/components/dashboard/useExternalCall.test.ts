import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

import { ConnectorLocator, type RestRequestPayload, type ServerConnector } from "@com.mgmtp.a12.utils/utils-connector";
import { LoggerFactory } from "@com.mgmtp.a12.utils/utils-logging";

import { useExternalCall } from "../../../components/dashboard/useExternalCall";

/**
 * As `useThingCounts.test.ts` does, only the HTTP boundary is replaced — in the same locator the hook
 * reaches through — so the framing, the headers and the id matching under test are the shipped ones and
 * what a test controls is exactly what the server said.
 *
 * The hook does not go through `Dispatcher.rpc` (it is typed to A12's built-in methods and its type
 * guards would refuse `EXTERNAL_CALL` outright), so this suite watches the wire rather than a mock: it
 * asserts on the request the connector was handed.
 */

/** One JSON-RPC request, as it is framed on the wire. */
interface RpcRequest {
    readonly id: unknown;
    readonly method: string;
    readonly params: { readonly operation: string; readonly args?: Record<string, unknown> };
}

/** Every request the installed server was handed, across every mount. */
let sent: RpcRequest[] = [];

/** How many times the hook went to the wire. "Nothing kept" is a claim about this number. */
let calls = 0;

interface Serving {
    /** Answers the request. Returning `undefined` sends a body that is not a JSON-RPC response at all. */
    readonly reply?: (request: RpcRequest) => unknown;
    /** `false` is a transport failure, which is a different path from a refusal. */
    readonly ok?: boolean;
    /** The connector itself rejects: the server is unreachable rather than unhappy. */
    readonly reject?: boolean;
}

function install({
    reply = (request) => answered(request.id, { name: "Giro" }),
    ok = true,
    reject = false
}: Serving = {}): void {
    sent = [];
    calls = 0;
    ConnectorLocator.createInstance({
        fetchData: (payload: RestRequestPayload) => {
            calls++;
            const requests = JSON.parse(String(payload.body)) as RpcRequest[];
            sent.push(...requests);
            if (reject) {
                return Promise.reject(new Error("connection refused"));
            }
            return Promise.resolve({
                ok,
                statusText: "Boom",
                json: () => Promise.resolve(requests.map(reply))
            } as unknown as Response);
        }
    } as unknown as ServerConnector);
}

/** What the server answers when the Runtime ran the Operation and it produced a value. */
function answered(id: unknown, value: unknown): object {
    return { jsonrpc: "2.0", id, result: { ok: true, outcome: { kind: "value", value } } };
}

/** What the server answers when the gate refused, or the Runtime could not be reached. */
function refused(id: unknown, reason: string): object {
    return { jsonrpc: "2.0", id, result: { ok: false, reason } };
}

/** A whole HTTP answer, for the tests that hold one open rather than installing a server. */
function served(value: unknown): object {
    return { ok: true, statusText: "", json: () => Promise.resolve([answered("external-call", value)]) };
}

const ARGS = { type: "asset" };

describe("useExternalCall", () => {
    beforeEach(() => {
        vi.spyOn(LoggerFactory.getLogger("PT/useExternalCall"), "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("asks for the operation by name, with its arguments, over EXTERNAL_CALL", async () => {
        install();

        const { result } = renderHook(() => useExternalCall("bookkeeping.listAccounts", ARGS));

        await waitFor(() => expect(result.current.state).toBe("ready"));
        expect(sent).toHaveLength(1);
        expect(sent[0]?.method).toBe("EXTERNAL_CALL");
        expect(sent[0]?.params).toEqual({ operation: "bookkeeping.listAccounts", args: ARGS });
    });

    it("goes from loading to ready, and stamps the instant it read", async () => {
        install({ reply: (request) => answered(request.id, [{ name: "Giro", balance: "96.500000000000" }]) });

        const { result } = renderHook(() => useExternalCall<{ name: string }[]>("bookkeeping.listAccounts"));

        expect(result.current.state).toBe("loading");
        await waitFor(() => expect(result.current.state).toBe("ready"));
        expect(result.current.state === "ready" && result.current.data[0]?.name).toBe("Giro");
        expect(result.current.state === "ready" && result.current.readAt).toBeInstanceOf(Date);
    });

    it("says error, and throws nothing, when the gate refuses", async () => {
        install({ reply: (request) => refused(request.id, "not-allowed") });

        const { result } = renderHook(() => useExternalCall("bookkeeping.postTransaction"));

        await waitFor(() => expect(result.current.state).toBe("error"));
    });

    it("says error, and throws nothing, when the request is rejected", async () => {
        install({
            reply: (request) => ({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "no", data: {} } })
        });

        const { result } = renderHook(() => useExternalCall("bookkeeping.listAccounts"));

        await waitFor(() => expect(result.current.state).toBe("error"));
    });

    it("says error, and throws nothing, when the transport fails", async () => {
        install({ ok: false });

        const { result } = renderHook(() => useExternalCall("bookkeeping.listAccounts"));

        await waitFor(() => expect(result.current.state).toBe("error"));
    });

    it("says error, and throws nothing, when the server cannot be reached at all", async () => {
        install({ reject: true });

        const { result } = renderHook(() => useExternalCall("bookkeeping.listAccounts"));

        await waitFor(() => expect(result.current.state).toBe("error"));
    });

    it("says error, and throws nothing, when the body is not the shape it was promised", async () => {
        install({ reply: (request) => ({ jsonrpc: "2.0", id: request.id, result: { ok: true } }) });

        const { result } = renderHook(() => useExternalCall("bookkeeping.listAccounts"));

        await waitFor(() => expect(result.current.state).toBe("error"));
    });

    it("says error for an outcome that is not a value, rather than inventing a meaning for it", async () => {
        // A client-callable read should never produce `pending` or `error`; if one does, the Tile shows
        // its error line rather than the hook deciding what a pending read means on a Dashboard.
        install({
            reply: (request) => ({
                jsonrpc: "2.0",
                id: request.id,
                result: { ok: true, outcome: { kind: "error", message: "Firefly timed out" } }
            })
        });

        const { result } = renderHook(() => useExternalCall("bookkeeping.listAccounts"));

        await waitFor(() => expect(result.current.state).toBe("error"));
    });

    it("keeps nothing between mounts, so leaving and returning re-asks Firefly", async () => {
        install();

        const first = renderHook(() => useExternalCall("bookkeeping.listAccounts", ARGS));
        await waitFor(() => expect(first.result.current.state).toBe("ready"));
        first.unmount();

        const second = renderHook(() => useExternalCall("bookkeeping.listAccounts", ARGS));
        await waitFor(() => expect(second.result.current.state).toBe("ready"));

        expect(calls).toBe(2);
        expect(second.result.current.state === "ready" && second.result.current.readAt).toBeInstanceOf(Date);
    });

    it("does not ask again when the same arguments are handed back on a re-render", async () => {
        install();

        const { result, rerender } = renderHook(
            ({ args }: { args: Record<string, unknown> }) => useExternalCall("bookkeeping.listAccounts", args),
            { initialProps: { args: ARGS } }
        );
        await waitFor(() => expect(result.current.state).toBe("ready"));

        // A Tile builds its argument object inline on every render, so object identity is exactly what
        // this hook must not depend on.
        rerender({ args: { ...ARGS } });
        await waitFor(() => expect(result.current.state).toBe("ready"));
        expect(calls).toBe(1);
    });

    it("asks again when the arguments actually change", async () => {
        install();

        const { result, rerender } = renderHook(
            ({ args }: { args: Record<string, unknown> }) => useExternalCall("bookkeeping.listAccounts", args),
            { initialProps: { args: ARGS } }
        );
        await waitFor(() => expect(result.current.state).toBe("ready"));

        rerender({ args: { type: "liabilities" } });
        await waitFor(() => expect(calls).toBe(2));
        expect(sent[1]?.params.args).toEqual({ type: "liabilities" });
    });

    it("ignores an answer to a call it is no longer making", async () => {
        // The slow answer to the *first* arguments arrives after the second call has already been
        // answered. Without the effect's cleanup it would land last and win, and the Tile would show
        // the liabilities under the heading it asked for assets — a wrong number, silently.
        const landings: ((value: unknown) => void)[] = [];
        ConnectorLocator.createInstance({
            fetchData: () =>
                new Promise((resolve) => {
                    landings.push(resolve);
                })
        } as unknown as ServerConnector);

        const { result, rerender } = renderHook(
            ({ args }: { args: Record<string, unknown> }) => useExternalCall<string>("bookkeeping.listAccounts", args),
            { initialProps: { args: ARGS } }
        );
        await waitFor(() => expect(landings).toHaveLength(1));
        rerender({ args: { type: "liabilities" } });
        await waitFor(() => expect(landings).toHaveLength(2));

        landings[1]?.(served("liabilities"));
        await waitFor(() => expect(result.current.state).toBe("ready"));
        landings[0]?.(served("assets"));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(result.current.state === "ready" && result.current.data).toBe("liabilities");
    });
});
