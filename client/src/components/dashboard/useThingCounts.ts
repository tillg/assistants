import { useEffect, useState } from "react";

import { Dispatcher, type QueryJsonRpc2Request } from "@com.mgmtp.a12.dataservices/dataservices-access";
import { LoggerFactory } from "@com.mgmtp.a12.utils/utils-logging";

/**
 * How many Things there are — as many counts as a Tile asks for, in one round trip.
 *
 * It is `useThingById`'s three invariants plus one, and the fourth is the one that makes this hook safe
 * to point at any Model:
 *
 * 1. **Read only.** There is no write path, and there is no Model this hook could write.
 * 2. **Fails soft.** A rejected request, an unreachable store, a malformed response: all of them are
 *    *nothing to show*, and none of them throws. The Tile renders its error line and the Dashboard
 *    stands.
 * 3. **No polling.** It reads on mount and when its query set changes. Each Tile shows the instant it
 *    read, and leaving the Dashboard and coming back re-reads.
 * 4. **Counts only.** It reads `fullSize` and discards `entries`, so nothing on the Dashboard can become
 *    a second copy of a Thing (ADR-0006 — the Dashboard counts, it does not keep).
 *
 * All of a Tile's counts go in **one** `Dispatcher.rpc` call: the dispatcher takes an array of requests
 * and returns an array of responses, so the conversations Tile is three counts in one trip and the
 * documents Tile is fourteen — and a Tile is never in a half-loaded state where two numbers are in and
 * one is not. Results reach their queries **by response id** and never by wire position: a batch response
 * is a JSON-RPC array whose order the protocol does not promise, and `Dispatcher.rpc` resolves each
 * request against its own id before returning. Giving every request a distinct id is what buys that.
 */

const logger = LoggerFactory.getLogger("PT/useThingCounts");

/** As in `useThingById`: this only reaches the `Accept-Language` header, and no text is read from here. */
const LANGUAGE = "en";

/**
 * `fullSize` is computed independently of the page, so a page of *nothing* is what a count actually
 * wants — but the store will not serve one: `paging.pageSize: 0` comes back as *"JSON-RPC Request failed
 * and rollback was performed"* for every request in the batch, measured against the live stack (see
 * DECISIONS.md). So it is `1`, and each count also drags back one document.
 *
 * The cost was measured rather than assumed: the documents Tile's fourteen counts weigh ~3.6 kB with
 * forty-nine Documents in the store, and the conversations Tile's three weigh ~12 kB, because a
 * Conversation carries its transcript while these Documents carry little `extractedText`. Kilobytes,
 * once per visit — which is why this is a recorded cost and not a redesign.
 */
const PAGE_SIZE = 1;

export interface CountQuery {
    /** The caller's own name for this count. Keys the result. */
    readonly key: string;
    /** A Document Model id, e.g. "Conversation_DM". */
    readonly model: string;
    /** Omitted counts every document of that Model. */
    readonly constraint?: object;
}

export type ThingCounts =
    | { readonly state: "loading" }
    | { readonly state: "ready"; readonly counts: Readonly<Record<string, number>>; readonly readAt: Date }
    | { readonly state: "error" };

const LOADING: ThingCounts = { state: "loading" };
const ERROR: ThingCounts = { state: "error" };

/** Counts every query in one round trip, and again whenever the queries change. Never throws. */
export function useThingCounts(queries: readonly CountQuery[]): ThingCounts {
    const [result, setResult] = useState<ThingCounts>(LOADING);

    // A Tile builds its query list inline on every render, so the effect may not depend on the array's
    // identity — only on what is in it. The queries are plain data, so their JSON *is* their identity,
    // and reading them back out of it is what keeps the effect's dependency honest with no ref and no
    // stale closure. The documents Tile makes this fourteen queries, not three.
    const fingerprint = JSON.stringify(queries);

    useEffect(() => {
        let live = true;
        setResult(LOADING);
        void countThings(JSON.parse(fingerprint) as CountQuery[]).then((counts) => {
            if (live) {
                setResult(counts === undefined ? ERROR : { state: "ready", counts, readAt: new Date() });
            }
        });
        return () => {
            live = false;
        };
    }, [fingerprint]);

    return result;
}

/** The request for one count: a projection of nothing, a page of nothing, and the caller's constraint. */
function request(query: CountQuery, index: number): QueryJsonRpc2Request {
    return {
        jsonrpc: "2.0",
        id: `count-${index}`,
        method: "QUERY",
        params: {
            query: {
                targetDocumentModel: query.model,
                projectionName: "document",
                paging: { pageNumber: 0, pageSize: PAGE_SIZE },
                ...(query.constraint ? { constraint: query.constraint } : {})
            }
        }
    } as QueryJsonRpc2Request;
}

async function countThings(queries: readonly CountQuery[]): Promise<Record<string, number> | undefined> {
    if (queries.length === 0) {
        return {};
    }

    try {
        // `Dispatcher.rpc` finds each request's response **by id** and hands them back in request order,
        // throwing if one is missing — so the wire order does not reach this loop, and giving every
        // request a distinct id is what buys that. The test proves it by replying in reverse.
        const responses = await Dispatcher.rpc(LANGUAGE, queries.map(request));
        const counts: Record<string, number> = {};

        queries.forEach((query, index) => {
            const fullSize = responses[index]?.result.fullSize;
            if (typeof fullSize !== "number") {
                throw new Error(`No count came back for ${query.key}`);
            }
            counts[query.key] = fullSize;
        });

        return counts;
    } catch (error) {
        // A count that could not be read is a fact about the world, not a defect. The Tile says so and
        // the other three Tiles are untouched.
        logger.warn(`Could not count ${queries.map((query) => query.key).join(", ")}.`, error);
        return undefined;
    }
}
