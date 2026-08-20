import { useEffect, useState } from "react";

import { Dispatcher, type QueryJsonRpc2Request } from "@com.mgmtp.a12.dataservices/dataservices-access";
import { LoggerFactory } from "@com.mgmtp.a12.utils/utils-logging";

/**
 * An Assistant's Name, resolved from the key a Conversation stores. A Conversation keeps only the key
 * (`Conversation_DM.AssistantKey`); the Name lives on the `Assistant_DM` Thing, so this reads it.
 *
 * It mirrors `useThingById`'s three invariants and adds nothing to them. **Read only** — a `QUERY`,
 * never a write. **No polling** — one read per distinct key, on mount. And, the one that is a domain
 * fact rather than a courtesy, **it fails soft to the key**: a renamed, disabled or deleted Assistant
 * leaves its Conversations behind, so a key that resolves to nothing is shown *as the key*. The screen
 * degrades to what it shows today; it never blanks and never throws.
 *
 * The query is the shape `useAssistants.ts` documents — same strictness, same `direction`-not-`order`
 * field names — with the paging-and-sort of a whole page swapped for an `exact_match` on the Key. A
 * module-level cache keeps a screen that mounts two badges for one key from asking twice; it is not a
 * store and holds nothing across a reload.
 */

const logger = LoggerFactory.getLogger("PT/useAssistantName");

/** As in `useThingById`: this only reaches the `Accept-Language` header, and no localisable text is read. */
const LANGUAGE = "en";

/** Resolved Names, by key. Not a store: a plain memo, emptied by any reload. */
const cache = new Map<string, string>();

/** Resolves `key` to the Assistant's Name, or to the key itself when nothing resolves. Never throws. */
export function useAssistantName(assistantKey: string): string {
    const [name, setName] = useState<string>(() => cache.get(assistantKey) ?? assistantKey);

    useEffect(() => {
        if (assistantKey === "") {
            setName("");
            return;
        }
        const known = cache.get(assistantKey);
        if (known !== undefined) {
            setName(known);
            return;
        }

        let live = true;
        // Fail-soft from the first frame: the key stands until — and unless — a Name arrives.
        setName(assistantKey);
        void readAssistantName(assistantKey).then((resolved) => {
            if (resolved !== undefined) {
                cache.set(assistantKey, resolved);
            }
            if (live) {
                setName(resolved ?? assistantKey);
            }
        });
        return () => {
            live = false;
        };
    }, [assistantKey]);

    return name;
}

function request(assistantKey: string): QueryJsonRpc2Request {
    return {
        jsonrpc: "2.0",
        id: `assistant-name/${assistantKey}`,
        method: "QUERY",
        params: {
            query: {
                targetDocumentModel: "Assistant_DM",
                projectionName: "document",
                // A Key is unique, so one row is all this ever wants.
                paging: { pageNumber: 0, pageSize: 1 },
                constraint: { operator: "exact_match", field: "/Assistant/Key", value: assistantKey }
            }
        }
    } as QueryJsonRpc2Request;
}

/** The Name off the one matching document, or nothing when no Assistant carries the key. */
async function readAssistantName(assistantKey: string): Promise<string | undefined> {
    try {
        const [response] = await Dispatcher.rpc(LANGUAGE, [request(assistantKey)]);
        const entries: unknown[] = response.result.entries ?? [];
        const body = (entries[0] as { document?: { Assistant?: Record<string, unknown> } } | undefined)?.document
            ?.Assistant;
        const resolved = body?.["Name"];
        return typeof resolved === "string" ? resolved : undefined;
    } catch (error) {
        // A rejected read is a fact about the world, not a defect: the key stands in for the Name.
        logger.warn(`Could not resolve the Name for Assistant '${assistantKey}'. Showing the key.`, error);
        return undefined;
    }
}
