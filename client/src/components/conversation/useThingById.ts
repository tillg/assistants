import { useEffect, useState } from "react";

import { Dispatcher, type DocumentJsonRpc2Request } from "@com.mgmtp.a12.dataservices/dataservices-access";
import { LoggerFactory } from "@com.mgmtp.a12.utils/utils-logging";

/**
 * One Thing, read by id, so that a screen can show the document *next to* the one it is bound to: the
 * Conversation form needs the pending question's words, and the question form needs the Conversation
 * that gives it context.
 *
 * It is a plain effect and not a saga. `Dispatcher.rpc` is a promise API over the `ServerConnector`
 * singleton — the same one `loadModelGraph.ts` reaches for — so nothing here needs the store, and a
 * saga would buy a channel, an action and a slice of state for a read that no reducer wants.
 *
 * Three invariants, and they are what keep this small:
 *
 * 1. **Read only.** There is no update path. Writing an answer is `CRUD::SAVE` on the Answer Surface,
 *    or nothing — reads may cross documents, writes may not.
 * 2. **Fails soft.** No id, a deleted Thing, a rejected request: all of them are *nothing to show*, and
 *    none of them throws. A form must never fail to open because a second document is missing.
 * 3. **No polling.** It reads on mount and when the id changes. A Conversation the Runtime is driving
 *    will be stale on screen, which is what it is today, and a reload is the User's existing answer.
 *
 * The docRef is composed here from the Model and the bare ThingID, because no Thing carries one:
 * ADR-0002 — a ThingID identifies and nothing more.
 */

const logger = LoggerFactory.getLogger("PT/useThingById");

/**
 * `GET_DOCUMENT` takes a docRef and nothing else, so this only reaches the `Accept-Language` header.
 * It is not the application's locale and does not have to be: no localisable text is read from here.
 */
const LANGUAGE = "en";

export type ThingById =
    | { readonly state: "loading" }
    | { readonly state: "ready"; readonly document: object }
    /** No id, no document, or no answer. One state for all three: there is nothing to show either way. */
    | { readonly state: "nothing" };

const LOADING: ThingById = { state: "loading" };
const NOTHING: ThingById = { state: "nothing" };

/** Reads `<model>/<thingId>` once, and again whenever the id changes. Never throws. */
export function useThingById(model: string, thingId: string | undefined): ThingById {
    const [result, setResult] = useState<ThingById>(thingId ? LOADING : NOTHING);

    useEffect(() => {
        if (!thingId) {
            setResult(NOTHING);
            return;
        }

        let live = true;
        setResult(LOADING);
        void readThing(model, thingId).then((document) => {
            if (live) {
                setResult(document === undefined ? NOTHING : { state: "ready", document });
            }
        });
        return () => {
            live = false;
        };
    }, [model, thingId]);

    return result;
}

async function readThing(model: string, thingId: string): Promise<object | undefined> {
    const docRef = `${model}/${thingId}`;
    const request: DocumentJsonRpc2Request.GetDocumentJsonRpc2Request = {
        jsonrpc: "2.0",
        id: docRef,
        method: "GET_DOCUMENT",
        params: { docRef }
    };

    try {
        const [response] = await Dispatcher.rpc(LANGUAGE, [request]);
        const document: unknown = response.result?.document;
        return typeof document === "object" && document !== null ? (document as object) : undefined;
    } catch (error) {
        // A rejected read is a fact about the world, not a defect: the Thing may be gone, or this User
        // may not be allowed it. The screen says so and stays usable.
        logger.warn(`Could not read ${docRef}. Showing nothing in its place.`, error);
        return undefined;
    }
}
