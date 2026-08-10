/*
 * SPDX-License-Identifier: EUPL-1.2 OR LicenseRef-commercial
 *
 * Copyright (c) 2012-2026 mgm technology partners GmbH
 *
 * Dual License
 * ------------
 * This source file is part of the mgm A12 Platform and available under
 * a choice of two different licenses:
 *
 * 1. Open-Source License - EUPL v1.2
 *    You may redistribute and/or modify this file under the terms of the
 *    European Union Public License, version 1.2 - see https://eupl.eu/.
 *
 * 2. Commercial License
 *    Alternatively, you may obtain a commercial license from
 *    mgm technology partners GmbH, that permits use of this software
 *    under different terms (including support and maintenance services).
 *
 *    Please contact a12-license@mgm-tp.com for more information.
 *
 * You must select and comply with exactly one of the above license options.
 *
 * Warranty Disclaimer (applies to either option)
 * ----------------------------------------------
 * THIS SOFTWARE IS PROVIDED "AS IS" AND WITHOUT WARRANTY OF ANY KIND,
 * WHETHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
 * OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NON-INFRINGEMENT, EXCEPT WHERE SUCH DISCLAIMERS ARE HELD TO BE
 * LEGALLY INVALID. SEE THE RESPECTIVE LICENSE TEXT FOR DETAILS.
 */

/**
 * A tiny ThingStore client for the tests that have to act *before* the UI does — creating the
 * arriving Document, watching for the Open Question the Assistants raise, and reading back what
 * the Runtime wrote.
 *
 * Two things about this API are easy to get wrong (the Runtime's own client says the same):
 *
 *   1. Authentication is not the store's job. It runs UAA with `authentication.types=OAUTH2`
 *      and has no login endpoint at all — Keycloak issues the token, over the direct access
 *      grant, and the store only verifies it. The scheme is a plain `Bearer`.
 *   2. The RPC body is always a JSON **array** (a batch), even for a single call.
 */

import USERS from "../fixtures/users.json" with { type: "json" };
import type { TestUsername } from "../types";

import { KEYCLOAK_CLIENT_ID, KEYCLOAK_REALM, KEYCLOAK_URL, THINGSTORE_URL } from "./config";

export type A12Document = Record<string, unknown>;

export interface Constraint {
    operator: string;
    [key: string]: unknown;
}

export interface ThingEntry {
    docRef: string;
    thingId: string;
    document: A12Document;
}

interface RpcResponse {
    id: string;
    result?: unknown;
    error?: { code: number; message: string; data?: { description?: { default?: string } } };
}

/** The store rejects anything larger, and says so only in the error's `data`. */
const MAX_PAGE_SIZE = 100;

/** `Document_DM/1234-…` → `1234-…`. A ThingID is the docRef without its Model. */
export function thingIdOf(docRef: string): string {
    return docRef.slice(docRef.indexOf("/") + 1);
}

export function docRefOf(model: string, thingId: string): string {
    return `${model}/${thingId}`;
}

/** A12 `DateTimeType` is modelled as `yyyy-MM-dd'T'HH:mm:ss` — no milliseconds, no zone suffix. */
export function nowIso(date: Date = new Date()): string {
    return date.toISOString().replace(/\.\d{3}Z$/, "");
}

export const eq = (field: string, value: string | number | boolean): Constraint => ({
    operator: "exact_match",
    field,
    value: String(value)
});

export const unset = (field: string): Constraint => ({ operator: "undefined_match", field });
export const not = (operand: Constraint): Constraint => ({ operator: "not", operands: [operand] });
export const and = (...operands: Constraint[]): Constraint => ({ operator: "and", operands });

export class ThingStore {
    private token: string | undefined;

    private constructor(
        private readonly baseUrl: string,
        private readonly username: string,
        private readonly password: string
    ) {}

    /**
     * Connect as `admin`. The tests need `DOCUMENT_DELETE` for their own clean-up, which the
     * `runtime` role deliberately does not have — an Assistant that hallucinates a delete gets
     * a 403, and the tests must not borrow the Runtime's identity anyway.
     */
    static async connect(username: TestUsername = "admin"): Promise<ThingStore> {
        const user = USERS[username];
        const store = new ThingStore(THINGSTORE_URL.replace(/\/+$/, ""), user.username, user.password);
        await store.login();
        return store;
    }

    async login(): Promise<void> {
        const url = `${KEYCLOAK_URL.replace(/\/+$/, "")}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`;
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
            body: new URLSearchParams({
                grant_type: "password",
                client_id: KEYCLOAK_CLIENT_ID,
                username: this.username,
                password: this.password
            })
        });
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new Error(`Keycloak login as ${this.username} failed: HTTP ${response.status} ${text.slice(0, 200)}`);
        }
        const payload = (await response.json()) as { access_token?: string };
        if (!payload.access_token) {
            throw new Error(`Keycloak accepted ${this.username} but returned no access_token`);
        }
        this.token = payload.access_token;
    }

    private async rpc<T>(id: string, method: string, params: Record<string, unknown>): Promise<T> {
        if (!this.token) {
            await this.login();
        }

        const send = (): Promise<Response> =>
            fetch(`${this.baseUrl}/api/v2/rpc`, {
                method: "POST",
                headers: {
                    Accept: "application/json",
                    // Not optional. The query engine resolves the request locale from this header
                    // and refuses anything that is not exactly one of the Model's locales —
                    // Node's `fetch` defaults to `*`, and `QUERY` then fails with
                    // "unsupported locale: *". A weighted list like `en-US,en;q=0.9` fails too.
                    "Accept-Language": "en",
                    "Content-Type": "application/json;charset=utf8",
                    // `Bearer`: the token is Keycloak's. `UAABearer` is for tokens UAA itself
                    // minted, which under OAUTH2 it never does.
                    Authorization: `Bearer ${this.token}`
                },
                body: JSON.stringify([{ jsonrpc: "2.0", id, method, params }])
            });

        let response = await send();
        if (response.status === 401) {
            await this.login();
            response = await send();
        }
        if (!response.ok) {
            throw new Error(`${method} failed: HTTP ${response.status} ${(await response.text()).slice(0, 400)}`);
        }

        const payload = (await response.json()) as RpcResponse[] | RpcResponse;
        const [result] = Array.isArray(payload) ? payload : [payload];
        if (!result) {
            throw new Error(`${method} returned no response`);
        }
        if (result.error) {
            // The message is always the same sentence; the useful half is in `data.description`.
            const detail = result.error.data?.description?.default ?? "";
            throw new Error(`${method} failed: ${result.error.message} (${result.error.code}) ${detail}`.trim());
        }
        return result.result as T;
    }

    async addDocument(documentModelName: string, document: A12Document): Promise<string> {
        const { docRef } = await this.rpc<{ docRef: string }>("add", "ADD_DOCUMENT", {
            document,
            documentModelName,
            locale: "en"
        });
        return docRef;
    }

    async getDocument(docRef: string): Promise<A12Document> {
        const spec = await this.rpc<{ document: A12Document }>("get", "GET_DOCUMENT", { docRef });
        return spec.document;
    }

    async modifyDocument(docRef: string, document: A12Document): Promise<void> {
        await this.rpc<void>("mod", "MODIFY_DOCUMENT", { docRef, document, locale: "en" });
    }

    async deleteDocument(docRef: string): Promise<void> {
        await this.rpc<void>("del", "DELETE_DOCUMENT", { docRef, locale: "en" });
    }

    async query(model: string, constraint?: Constraint, pageSize = MAX_PAGE_SIZE): Promise<ThingEntry[]> {
        const query: Record<string, unknown> = {
            targetDocumentModel: model,
            projectionName: "document",
            paging: { pageNumber: 0, pageSize: Math.min(pageSize, MAX_PAGE_SIZE) }
        };
        if (constraint) {
            query["constraint"] = constraint;
        }

        const result = await this.rpc<{ entries?: Array<{ docRef: string; document: A12Document }> }>("q", "QUERY", {
            query
        });
        return (result.entries ?? []).map((entry) => ({
            docRef: entry.docRef,
            thingId: thingIdOf(entry.docRef),
            document: entry.document
        }));
    }

    /** The body of a Thing, i.e. what sits under its root group: `{ Party: { … } }` → `{ … }`. */
    async body(docRef: string, root: string): Promise<Record<string, unknown>> {
        const document = await this.getDocument(docRef);
        return (document[root] ?? {}) as Record<string, unknown>;
    }

    /**
     * Patch one Thing. MODIFY_DOCUMENT replaces the document, so this reads it first and writes
     * the whole thing back — the same shape the Runtime's repository uses.
     */
    async patch(docRef: string, root: string, fields: Record<string, unknown>): Promise<void> {
        const document = await this.getDocument(docRef);
        const body = (document[root] ?? {}) as Record<string, unknown>;
        await this.modifyDocument(docRef, { ...document, [root]: { ...body, ...fields, UpdatedAt: nowIso() } });
    }

    // ------------------------------------------------------------------ the kill switch

    private async runtimeStateDocRef(): Promise<string> {
        const [state] = await this.query("RuntimeState_DM", undefined, 5);
        if (!state) {
            throw new Error("No RuntimeState_DM singleton — has `just bootstrap` run?");
        }
        return state.docRef;
    }

    async setPaused(paused: boolean): Promise<void> {
        const docRef = await this.runtimeStateDocRef();
        await this.patch(docRef, "RuntimeState", { Paused: paused });
    }

    /**
     * Run destructive setup with the Runtime stopped.
     *
     * Deleting Things the Assistants are working on, while they are working on them, is how a
     * clean-up pass turns into a flaky suite. `RuntimeState.paused` is the global kill switch
     * exactly for this, and it is always released again.
     */
    async withRuntimePaused<T>(work: () => Promise<T>): Promise<T> {
        await this.setPaused(true);
        // One scan interval, so a scan already in flight has finished before we touch anything.
        await sleep(2_500);
        try {
            return await work();
        } finally {
            await this.setPaused(false);
        }
    }
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `probe` until it returns something truthy, or give up.
 *
 * The whole system is eventually consistent by design — the watcher notices work every two
 * seconds — so every cross-component assertion in this suite is a poll, never a sleep.
 */
export async function waitFor<T>(
    description: string,
    probe: () => Promise<T | undefined>,
    timeoutMs: number,
    intervalMs = 1_000
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    do {
        try {
            const value = await probe();
            if (value !== undefined && value !== null && value !== false) {
                return value;
            }
        } catch (error) {
            lastError = error;
        }
        await sleep(intervalMs);
    } while (Date.now() < deadline);

    const because = lastError instanceof Error ? ` (last error: ${lastError.message})` : "";
    throw new Error(`Timed out after ${timeoutMs} ms waiting for: ${description}${because}`);
}
