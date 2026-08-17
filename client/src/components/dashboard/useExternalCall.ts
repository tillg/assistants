import { useEffect, useState } from "react";

import { JsonRpc2Request, JsonRpc2Response } from "@com.mgmtp.a12.dataservices/dataservices-access";
import { ConnectorLocator } from "@com.mgmtp.a12.utils/utils-connector";
import { LoggerFactory } from "@com.mgmtp.a12.utils/utils-logging";

/**
 * One read of something that is not in the store — a Runtime Operation, run for a Tile and forgotten.
 *
 * It is `useThingCounts`' four invariants plus a fifth, and the fifth is the one that makes a hook
 * pointed *outside* the application safe to have at all:
 *
 * 1. **Read only.** There is no method parameter and no write path. What may be called at all is
 *    decided twice more behind this hook — by the server's allowlist and by the Runtime's `clientReadable`
 *    — and a browser asking for a mutating Operation is refused there, not trusted here.
 * 2. **Fails soft.** A refusal, a timeout, an unreachable Runtime, a body in a shape nobody promised:
 *    all of them are *nothing to show*, and none of them throws. The Tile renders its error line and
 *    the other five Tiles stand.
 * 3. **No polling.** It reads on mount and when the call changes. `readAt` is stamped from the response
 *    and shown by `asOf()` in the footer, because a number nothing refreshes must never be mistaken for
 *    a live one.
 * 4. **Nothing kept.** No module cache, no redux slice, no `sessionStorage`. Leaving the Dashboard and
 *    coming back re-asks Firefly, which is the whole of ADR-0022 applied to somebody else's data: the
 *    household's balances exist in the books and nowhere in this application.
 * 5. **Not the Authority.** No arithmetic on what comes back. The value is handed to the Tile as it
 *    arrived; the only sums are `money.ts`' per-currency totals, computed for display and discarded
 *    with the component.
 *
 * **Why not `Dispatcher.rpc`.** It is typed to A12's built-in requests, and its own `.d.ts` warns that
 * anything else *"will lead to compile and runtime errors"* — the dispatcher looks the method up in a
 * table of response type guards, and `EXTERNAL_CALL` is not in it. So this uses the untyped escape
 * hatch instead: `JsonRpc2Request.build()` over the configured `ServerConnector`, which is what mgm's
 * own Workflows client does. Authentication, the base URL and the headers still come from the
 * connector; only the typing of this one method is ours, and the seam a test replaces is the same one
 * `useThingCounts`' tests replace.
 */

const logger = LoggerFactory.getLogger("PT/useExternalCall");

/** As in `useThingCounts`: this only reaches the `Accept-Language` header, and no text is read from here. */
const LANGUAGE = "en";

/** One request, so one id; it is still matched by id rather than by position, as the protocol requires. */
const ID = "external-call";

export type ExternalCall<T> =
    | { readonly state: "loading" }
    | { readonly state: "ready"; readonly data: T; readonly readAt: Date }
    | { readonly state: "error" };

const LOADING: ExternalCall<never> = { state: "loading" };
const ERROR: ExternalCall<never> = { state: "error" };

/** Runs one Operation on the Runtime, and again whenever the call changes. Never throws. */
export function useExternalCall<T>(operation: string, args?: Record<string, unknown>): ExternalCall<T> {
    const [result, setResult] = useState<ExternalCall<T>>(LOADING);

    // A Tile builds its argument object inline on every render, so the effect may not depend on the
    // object's identity — only on what is in it. The arguments are plain data, so their JSON *is* their
    // identity, and reading them back out of it is what keeps the effect's dependency honest with no
    // ref and no stale closure.
    const fingerprint = JSON.stringify({ operation, args: args ?? {} });

    useEffect(() => {
        let live = true;
        setResult(LOADING);
        void call<T>(JSON.parse(fingerprint) as Call).then((data) => {
            // The answer to a Tile that has gone is nothing to anyone: dropping it here is what stops a
            // setState landing after unmount when a User leaves the Dashboard mid-read.
            if (live) {
                setResult(data === undefined ? ERROR : { state: "ready", data, readAt: new Date() });
            }
        });
        return () => {
            live = false;
        };
    }, [fingerprint]);

    return result;
}

interface Call {
    readonly operation: string;
    readonly args: Record<string, unknown>;
}

/** What the server answers: the Runtime ran it, or the gate refused. Only the first has anything in it. */
interface ExternalCallResult {
    readonly ok?: boolean;
    readonly reason?: string;
    readonly outcome?: { readonly kind?: string; readonly value?: unknown };
}

async function call<T>({ operation, args }: Call): Promise<T | undefined> {
    try {
        const request = JsonRpc2Request.build([
            { jsonrpc: "2.0", id: ID, method: "EXTERNAL_CALL", params: { operation, args } }
        ]);
        const response = await ConnectorLocator.getInstance()
            .getServerConnector()
            .fetchData({
                ...request,
                customHeaders: [...(request.customHeaders ?? []), ["Accept-Language", LANGUAGE]]
            });

        // `fetchData` is typed to return an `object`, so everything from here down is a body this hook
        // has been promised and has not seen. Each step that could be a lie is a throw, and every throw
        // lands in the one `catch` below as *nothing to show*.
        const http = response as Response;
        if (!http.ok) {
            throw new Error(http.statusText);
        }

        const answered = (await http.json()) as unknown;
        const found = (Array.isArray(answered) ? answered : [answered]).find(
            (candidate) => JsonRpc2Response.isInstance(candidate) && candidate.id === ID
        ) as JsonRpc2Response | undefined;

        if (found === undefined || JsonRpc2Response.hasError(found)) {
            throw new Error(`${operation} was rejected`);
        }

        const result = found.result as ExternalCallResult | undefined;
        if (result?.ok !== true) {
            // A refusal names a reason and never the Operation's existence — `not-allowed` covers
            // unknown, disallowed, disabled and mutating alike — so there is nothing here to show a User.
            throw new Error(`${operation} was refused: ${result?.reason ?? "no reason given"}`);
        }
        if (result.outcome?.kind !== "value") {
            // `pending` and `error` are passed through by the Runtime rather than translated, and a
            // client-callable read should produce neither. The Tile shows its error line instead.
            throw new Error(`${operation} produced ${result.outcome?.kind ?? "nothing"}`);
        }

        return result.outcome.value as T;
    } catch (error) {
        // A read that could not be made is a fact about the world — the books are elsewhere and may be
        // down — not a defect. The Tile says so and the rest of the Dashboard is untouched.
        logger.warn(`Could not call ${operation}.`, error);
        return undefined;
    }
}
