/*
 * SPDX-License-Identifier: EUPL-1.2
 *
 * Copyright (c) 2026 Till Gartner
 *
 * Part of Assistants.
 *
 * Licensed under the European Union Public Licence, version 1.2 - see
 * https://eupl.eu/ and the LICENSE file at the root of this repository.
 * Distributed on an "AS IS" basis, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.
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

import { readFileSync } from "node:fs";
import { basename } from "node:path";

import USERS from "../fixtures/users.json" with { type: "json" };
import type { TestUsername } from "../types";

import { KEYCLOAK_CLIENT_ID, KEYCLOAK_REALM, KEYCLOAK_URL, THINGSTORE_URL } from "./config";

/**
 * Avoiding Keycloak's quick-login lockout, rather than waiting it out.
 *
 * The realm sets `quickLoginCheckMilliSeconds: 1000`, so two logins **as the same user inside one
 * second** are treated as a credential-stuffing burst and the user is disabled for a minute — even
 * when both succeed. Specs run in parallel workers and several call `ThingStore.connect("admin")`
 * in their `beforeAll`, which Playwright starts together, so the collision is close to certain.
 *
 * Waiting the lockout out was the first fix and it was the wrong one: the wait has to exceed
 * `minimumQuickLoginWaitSeconds` (60), and a `beforeAll` only gets the 60-second budget
 * `playwright.config.ts` grants a test — so the hook died before the retry could land. Spreading
 * the logins over a window wider than the check instead means the burst never forms. The retry
 * stays as a safety net, with a wait that fits inside the budget it runs in.
 */
const QUICK_LOGIN_JITTER_MS = 2_500;
const QUICK_LOGIN_WAIT_MS = 15_000;
const QUICK_LOGIN_ATTEMPTS = 3;

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

/** Exactly what a `Document_DM` `Attachment` group needs to be openable in the web application. */
export interface UploadedAttachment {
    original_filename: string;
    internal_filename: string;
    attachment_id: string;
    size: number;
    mime_type: string;
}

/** The A12 `AttachmentHeader` the upload answers with — only `attachmentId` is guaranteed. */
interface AttachmentHeader {
    attachmentId: string;
    filename?: string;
    mimeType?: string;
    size?: number;
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
/**
 * NOTE the singular `operand`. `and` and `or` take `operands` (plural, an array); `not` takes `operand`
 * (singular), exactly as `runtime/src/a12/things.ts` documents. The plural form is rejected with
 * *"JSON-RPC Request failed and rollback was performed"* — measured against the live store, which is how
 * this was found: the helper had no caller until the dashboard spec became its first.
 */
export const not = (operand: Constraint): Constraint => ({ operator: "not", operand });
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

    /**
     * Get a token, retrying past Keycloak's **quick-login** lockout.
     *
     * The realm sets `quickLoginCheckMilliSeconds: 1000` with `minimumQuickLoginWaitSeconds: 60`,
     * so two logins **as the same user within one second** are treated as a credential-stuffing
     * burst and the user is disabled for a minute — *even when both logins succeed*. That is not a
     * hypothetical: specs run in parallel workers, several call `ThingStore.connect("admin")` in
     * their `beforeAll`, and Playwright starts them together. The result is a 401 in whichever spec
     * lost the race, reported as `invalid_grant` / "Invalid user credentials", which reads as a
     * wrong password and is nothing of the kind. It cost a wrong commit to learn that.
     *
     * The realm is left alone — the protection is doing its job on a pattern that is genuinely
     * suspicious anywhere but here. Jitter (above) is what prevents the burst; the retry below is
     * only a safety net, bounded to fit inside the 60-second budget a `beforeAll` gets.
     */
    async login(): Promise<void> {
        const url = `${KEYCLOAK_URL.replace(/\/+$/, "")}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`;
        let lastFailure = "";

        // Spread across a window wider than the realm's one-second check, so parallel workers do
        // not arrive together in the first place.
        await new Promise((resolve) => setTimeout(resolve, Math.random() * QUICK_LOGIN_JITTER_MS));

        for (let attempt = 1; attempt <= QUICK_LOGIN_ATTEMPTS; attempt += 1) {
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

            if (response.ok) {
                const payload = (await response.json()) as { access_token?: string };
                if (!payload.access_token) {
                    throw new Error(`Keycloak accepted ${this.username} but returned no access_token`);
                }
                this.token = payload.access_token;
                return;
            }

            lastFailure = `HTTP ${response.status} ${(await response.text().catch(() => "")).slice(0, 200)}`;
            // Only a 401 is worth waiting out. Anything else — a wrong client, an unreachable
            // Keycloak — will not improve in sixty seconds and should fail now, loudly.
            if (response.status !== 401 || attempt === QUICK_LOGIN_ATTEMPTS) {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, QUICK_LOGIN_WAIT_MS));
        }

        throw new Error(`Keycloak login as ${this.username} failed: ${lastFailure}`);
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

    /**
     * Store a file's bytes in the A12 Content Store and return the attachment group `ADD_DOCUMENT`
     * wants under a `Document_DM`'s `Attachment`.
     *
     * The route is the one the web application's own uploader uses and the Runtime's
     * `runtime/src/a12/content.ts` already replicates for the mail ingest — a plain REST POST with
     * the **raw bytes as the body** and every parameter in the query string:
     *
     *     POST {baseUrl}/api/v2/attachment
     *          ?filename=<name>&documentModelName=<model>&pathToField=<path to the attachment group>
     *
     * built by `AttachmentUploadV2.Request.build` in
     * `@com.mgmtp.a12.dataservices/dataservices-access`. Three details are copied deliberately from
     * that reference: the query string is encoded exactly once; `Content-Type` is
     * `application/json;charset=utf8` on a binary body (A12's `HeadersFilter` sets it wholesale, and
     * the server reads the stream regardless of the label); and the token is a plain `Bearer`, the
     * same Keycloak token {@link rpc} carries. The response is an A12 `AttachmentHeader` whose only
     * guaranteed field is `attachmentId`; the rest fall back so the group stays valid.
     */
    async uploadAttachment(
        filePath: string,
        mimeType: string,
        documentModelName = "Document_DM",
        pathToField = "/Document/Attachment"
    ): Promise<UploadedAttachment> {
        if (!this.token) {
            await this.login();
        }
        const bytes = readFileSync(filePath);
        const filename = basename(filePath);
        const query =
            `filename=${encodeURIComponent(filename)}` +
            `&documentModelName=${encodeURIComponent(documentModelName)}` +
            `&pathToField=${encodeURIComponent(pathToField)}`;
        const url = `${this.baseUrl}/api/v2/attachment?${query}`;

        const send = (): Promise<Response> =>
            fetch(url, {
                method: "POST",
                headers: {
                    Accept: "application/json",
                    // Binary body, JSON label — mirrors what the web application sends. See the note
                    // in runtime/src/a12/content.ts; the server reads the stream regardless.
                    "Content-Type": "application/json;charset=utf8",
                    Authorization: `Bearer ${this.token}`
                },
                body: bytes
            });

        let response = await send();
        if (response.status === 401) {
            await this.login();
            response = await send();
        }
        if (!response.ok) {
            throw new Error(
                `attachment upload failed: HTTP ${response.status} ${(await response.text()).slice(0, 400)}`
            );
        }

        const header = (await response.json()) as AttachmentHeader;
        if (!header?.attachmentId) {
            throw new Error(`attachment upload returned no attachmentId: ${JSON.stringify(header).slice(0, 200)}`);
        }
        return {
            original_filename: filename,
            internal_filename: header.filename ?? filename,
            attachment_id: header.attachmentId,
            size: header.size ?? bytes.length,
            mime_type: header.mimeType ?? mimeType
        };
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

    /**
     * How many Things match, without reading them.
     *
     * `fullSize` is computed independently of the page, so this asks for the smallest page the store
     * will serve — one. (It will not serve none: `pageSize: 0` is rejected outright.) The Dashboard's
     * spec needs this because the overviews it would otherwise count run to forty pages.
     */
    async count(model: string, constraint?: Constraint): Promise<number> {
        const query: Record<string, unknown> = {
            targetDocumentModel: model,
            projectionName: "document",
            paging: { pageNumber: 0, pageSize: 1 }
        };
        if (constraint) {
            query["constraint"] = constraint;
        }

        const result = await this.rpc<{ fullSize?: number }>("count", "QUERY", { query });
        return result.fullSize ?? 0;
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
