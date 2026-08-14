import { useState, type PropsWithChildren } from "react";
import { Provider } from "react-redux";
import { ThemeProvider } from "styled-components";
import type { Store } from "redux";

import { ConnectorLocator } from "@com.mgmtp.a12.utils/utils-connector";
import type { RestRequestPayload, ServerConnector } from "@com.mgmtp.a12.utils/utils-connector";
import { getBaseTheme } from "@com.mgmtp.a12.widgets/widgets-core";

/**
 * The two providers the Transcript's components need to render: the A12 widget theme, because every
 * colour comes from it, and a store, because a navigation is a dispatch. Neither is stubbed out with a
 * fake — the theme is the real one and the store records what was dispatched, which is the assertion.
 *
 * Where a component reads a second document, this file also installs a server. Only the HTTP boundary is
 * replaced, in the locator the platform's own dispatcher already reads, so the JSON-RPC framing and the
 * error handling under test are the shipped ones and what a test controls is what the server said.
 *
 * This file deliberately imports nothing from `@testing-library/react`: it would be the only
 * non-`*.test.*` file allowed to reach for a devDependency, and it does not need to.
 */

/** A store that does nothing but remember what it was asked to do. */
export function recordingStore(): { readonly actions: unknown[]; readonly store: Store } {
    const actions: unknown[] = [];
    const store = {
        getState: () => ({}),
        dispatch: (action: unknown) => {
            actions.push(action);
            return action;
        },
        subscribe: () => () => {},
        replaceReducer: () => {}
    };
    return { actions, store: store as unknown as Store };
}

/** One JSON-RPC request, as the dispatcher frames it on the wire. */
export interface RpcRequest {
    readonly id: unknown;
    readonly method: string;
    readonly params: { readonly docRef?: string };
}

/**
 * Installs a server answering whatever the reply function returns for each request in a batch.
 * `ok: false` is a transport failure, which the dispatcher treats differently from a rejected request.
 */
export function serveRpc(reply: (request: RpcRequest) => unknown, ok = true): { readonly asked: RpcRequest[] } {
    const asked: RpcRequest[] = [];
    ConnectorLocator.createInstance({
        fetchData: (payload: RestRequestPayload) => {
            const requests = JSON.parse(String(payload.body)) as RpcRequest[];
            asked.push(...requests);
            return Promise.resolve({
                ok,
                statusText: "Boom",
                json: () => Promise.resolve(requests.map(reply))
            } as unknown as Response);
        }
    } as unknown as ServerConnector);
    return { asked };
}

/**
 * Answers `GET_DOCUMENT` from a table of docRefs. A docRef the table does not have is answered the way
 * the store answers for a Thing that is not there: with an error, not with an empty document.
 */
export function serveDocuments(documents: Readonly<Record<string, object>>): { readonly asked: RpcRequest[] } {
    return serveRpc((request) => {
        const docRef = request.params.docRef ?? "";
        const document = documents[docRef];
        return document === undefined
            ? {
                  jsonrpc: "2.0",
                  id: request.id,
                  error: { code: -32603, message: `No document entry found for docRef ${docRef}`, data: {} }
              }
            : { jsonrpc: "2.0", id: request.id, result: { docRef, documentModelName: docRef.split("/")[0], document } };
    });
}

/**
 * Wraps a component in the theme and the store it is rendered under in the application.
 *
 * The fallback store is built once and kept, not evaluated in the JSX: a fresh store on every render
 * would make `Provider` re-subscribe on each one and would throw away what the last render recorded,
 * which is precisely the promise this file makes about it.
 */
export function Frame({ store, children }: PropsWithChildren<{ readonly store?: Store }>) {
    const [fallback] = useState(() => recordingStore().store);
    return (
        <Provider store={store ?? fallback}>
            <ThemeProvider theme={getBaseTheme()}>{children}</ThemeProvider>
        </Provider>
    );
}
