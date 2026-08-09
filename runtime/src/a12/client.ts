/**
 * JSON-RPC client for the A12 Data Service — our ThingStore.
 *
 * Two things about this API are easy to get wrong and expensive to discover:
 *
 *   1. Authentication is UAA LOCAL: POST /api/user/local/login with a JSON body, and the JWT
 *      comes back in a **response header**, not the body. Subsequent calls use the scheme
 *      `UAABearer`, not `Bearer`.
 *   2. The RPC body is always a JSON **array** (a batch), even for a single call, and mutations
 *      must precede queries within one batch.
 */

import { log, describeError } from "../log.js";

export interface A12Error {
    code: number;
    message: string;
    data?: unknown;
}

export class A12RpcError extends Error {
    constructor(
        readonly method: string,
        readonly rpcError: A12Error,
    ) {
        super(`${method} failed: ${rpcError.message} (code ${rpcError.code})`);
        this.name = "A12RpcError";
    }
}

export interface RpcRequest {
    id: string;
    method: string;
    params: Record<string, unknown>;
}

interface RpcResponse {
    jsonrpc: "2.0";
    id: string;
    result?: unknown;
    error?: A12Error;
}

export type A12Document = Record<string, unknown>;

export interface DocumentSpec {
    docRef: string;
    documentModelName: string;
    document: A12Document;
}

export interface QueryEntry {
    type: string;
    docRef: string;
    documentModelName: string;
    document: A12Document;
}

export interface QueryResult {
    fullSize: number;
    entries: QueryEntry[];
}

export interface Constraint {
    operator: string;
    [key: string]: unknown;
}

export interface QuerySpec {
    targetDocumentModel: string;
    projectionName?: string;
    constraint?: Constraint;
    paging?: { pageNumber: number; pageSize: number };
    sort?: Array<{ field: string; order: "ASC" | "DESC"; nulls?: string }>;
}

export interface A12ClientOptions {
    baseUrl: string;
    username: string;
    password: string;
    locale?: string;
    fetchImpl?: typeof fetch;
}

export class A12Client {
    private token: string | undefined;
    private readonly baseUrl: string;
    private readonly locale: string;
    private readonly doFetch: typeof fetch;

    constructor(private readonly options: A12ClientOptions) {
        this.baseUrl = options.baseUrl.replace(/\/+$/, "");
        this.locale = options.locale ?? "en";
        this.doFetch = options.fetchImpl ?? fetch;
    }

    /**
     * UAA LOCAL login. The token arrives in the `access_token` response header.
     * We never proactively renew: the token lasts 30 minutes and this process talks to the
     * store every couple of seconds, so re-logging-in on the first 401 is simpler and cheaper
     * than running the PKCE renew pair.
     */
    async login(): Promise<void> {
        const url = `${this.baseUrl}/api/user/local/login`;
        const response = await this.doFetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ username: this.options.username, password: this.options.password }),
        });
        if (!response.ok) {
            throw new Error(`Login as ${this.options.username} failed: HTTP ${response.status}`);
        }
        const token = response.headers.get("access_token");
        if (!token) {
            throw new Error("Login succeeded but no access_token header was returned");
        }
        this.token = token;
        log.debug("logged in to the ThingStore", { user: this.options.username });
    }

    private async ensureToken(): Promise<string> {
        if (!this.token) await this.login();
        return this.token!;
    }

    /** Send a batch. Retries exactly once after a re-login when the store answers 401. */
    async rpc(requests: RpcRequest[]): Promise<unknown[]> {
        if (requests.length === 0) return [];
        const body = JSON.stringify(requests.map((r) => ({ jsonrpc: "2.0", ...r })));

        const send = async (token: string): Promise<Response> =>
            this.doFetch(`${this.baseUrl}/api/v2/rpc`, {
                method: "POST",
                headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json;charset=utf8",
                    Authorization: `UAABearer ${token}`,
                },
                body,
            });

        let response = await send(await this.ensureToken());
        if (response.status === 401) {
            log.debug("ThingStore returned 401, re-authenticating");
            this.token = undefined;
            response = await send(await this.ensureToken());
        }
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new Error(`RPC failed: HTTP ${response.status} ${text.slice(0, 500)}`);
        }

        const payload = (await response.json()) as RpcResponse[] | RpcResponse;
        const responses = Array.isArray(payload) ? payload : [payload];
        const byId = new Map(responses.map((r) => [r.id, r]));

        return requests.map((request) => {
            const result = byId.get(request.id);
            if (!result) throw new Error(`No response for request ${request.id} (${request.method})`);
            if (result.error) throw new A12RpcError(request.method, result.error);
            return result.result;
        });
    }

    private async one<T>(request: RpcRequest): Promise<T> {
        const [result] = await this.rpc([request]);
        return result as T;
    }

    async addDocument(documentModelName: string, document: A12Document): Promise<string> {
        const result = await this.one<{ docRef: string }>({
            id: "add",
            method: "ADD_DOCUMENT",
            params: { document, documentModelName, locale: this.locale },
        });
        return result.docRef;
    }

    async getDocument(docRef: string): Promise<DocumentSpec> {
        return this.one<DocumentSpec>({ id: "get", method: "GET_DOCUMENT", params: { docRef } });
    }

    async modifyDocument(docRef: string, document: A12Document): Promise<void> {
        // MODIFY_DOCUMENT returns nothing; success is the absence of an error.
        await this.one<void>({
            id: "mod",
            method: "MODIFY_DOCUMENT",
            params: { docRef, document, locale: this.locale },
        });
    }

    async deleteDocument(docRef: string): Promise<void> {
        await this.one<void>({
            id: "del",
            method: "DELETE_DOCUMENT",
            params: { docRef, locale: this.locale },
        });
    }

    async query(spec: QuerySpec): Promise<QueryResult> {
        const query: Record<string, unknown> = {
            targetDocumentModel: spec.targetDocumentModel,
            projectionName: spec.projectionName ?? "document",
            paging: spec.paging ?? { pageNumber: 0, pageSize: 100 },
        };
        if (spec.constraint) query["constraint"] = spec.constraint;
        if (spec.sort) query["sort"] = spec.sort;

        const result = await this.one<{ fullSize: number; entries?: QueryEntry[] }>({
            id: "q",
            method: "QUERY",
            params: { query },
        });
        return { fullSize: result.fullSize ?? 0, entries: result.entries ?? [] };
    }

    /** Used by the health probe and by `just dev` to wait for the store. */
    async isReachable(): Promise<boolean> {
        try {
            const response = await this.doFetch(`${this.baseUrl}/actuator/health`);
            return response.ok;
        } catch (error) {
            log.debug("ThingStore not reachable yet", { error: describeError(error) });
            return false;
        }
    }
}
