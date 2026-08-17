import { useEffect, useState } from "react";

import { Dispatcher, type QueryJsonRpc2Request } from "@com.mgmtp.a12.dataservices/dataservices-access";
import { LoggerFactory } from "@com.mgmtp.a12.utils/utils-logging";

/**
 * The household's staff, by name — the one Tile that reads documents, because a name is not a count.
 *
 * It keeps `useThingCounts`' four invariants, and the fourth is the one that needed reading across
 * rather than dropping: **fields only**. `Key`, `Name` and `Enabled` are lifted off each document and
 * the rest of it — `SystemPrompt`, every Skill's markdown — is discarded rather than held in React
 * state. It is the one hook here that touches a document body, so it is the one that has to say what it
 * keeps.
 *
 * The sort is not optional. Without it the render order is whatever the store returns, which makes both
 * the list and the *"and N more"* cut arbitrary between reads — and all four sort fields have to be
 * present or the server rejects the query outright, with its own field names (`direction`, not `order`).
 */

const logger = LoggerFactory.getLogger("PT/useAssistants");

/** As in `useThingById`: this only reaches the `Accept-Language` header. */
const LANGUAGE = "en";

/**
 * One page of Assistants. Unrelated to `useThingCounts`' page size, which is a count optimisation and
 * would be wrong here: this hook wants the documents. `total` may exceed it, and the Tile says so.
 */
const PAGE_SIZE = 25;

/** One Assistant, in the terms the Tile renders it. Read by name off the document, as `entries.ts` does. */
export interface AssistantSummary {
    readonly key: string;
    readonly name: string;
    readonly enabled: boolean;
}

export type Assistants =
    | { readonly state: "loading" }
    | {
          readonly state: "ready";
          /** At most `PAGE_SIZE` of them, in `Name` ascending. */
          readonly assistants: readonly AssistantSummary[];
          /** `fullSize` — may exceed `assistants.length`, and the Tile says so when it does. */
          readonly total: number;
          readonly readAt: Date;
      }
    | { readonly state: "error" };

const LOADING: Assistants = { state: "loading" };
const ERROR: Assistants = { state: "error" };

/** Reads one sorted page of Assistants on mount. Never polls, and never throws. */
export function useAssistants(): Assistants {
    const [result, setResult] = useState<Assistants>(LOADING);

    useEffect(() => {
        let live = true;
        void readAssistants().then((read) => {
            if (live) {
                setResult(read === undefined ? ERROR : { state: "ready", ...read, readAt: new Date() });
            }
        });
        return () => {
            live = false;
        };
    }, []);

    return result;
}

const REQUEST = {
    jsonrpc: "2.0",
    id: "assistants",
    method: "QUERY",
    params: {
        query: {
            targetDocumentModel: "Assistant_DM",
            projectionName: "document",
            paging: { pageNumber: 0, pageSize: PAGE_SIZE },
            sort: [{ field: "/Assistant/Name", direction: "ASC", nullHandling: "NULLS_LAST", ignoreCase: true }]
        }
    }
} as QueryJsonRpc2Request;

/** The three fields, off one entry's document. An entry with no name is not an Assistant anyone can show. */
function summarise(entry: unknown): AssistantSummary | undefined {
    const body = (entry as { document?: { Assistant?: Record<string, unknown> } }).document?.Assistant;
    const key = body?.["Key"];
    const name = body?.["Name"];
    if (typeof key !== "string" || typeof name !== "string") {
        return undefined;
    }
    return { key, name, enabled: body?.["Enabled"] === true };
}

async function readAssistants(): Promise<{ assistants: AssistantSummary[]; total: number } | undefined> {
    try {
        const [response] = await Dispatcher.rpc(LANGUAGE, [REQUEST]);
        // `entries` is optional on the response type — a projection may return none at all.
        const entries: unknown[] = response.result.entries ?? [];
        return {
            assistants: entries.map(summarise).filter((assistant): assistant is AssistantSummary => !!assistant),
            total: response.result.fullSize
        };
    } catch (error) {
        // Fails soft, like every read on this Dashboard: the Tile says so and the other three stand.
        logger.warn("Could not read the Assistants. Showing nothing in their place.", error);
        return undefined;
    }
}
