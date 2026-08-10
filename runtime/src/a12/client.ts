/**
 * JSON-RPC client for the A12 Data Service — our ThingStore.
 *
 * Two things about this API are easy to get wrong and expensive to discover:
 *
 *   1. Authentication is Keycloak, not the ThingStore. The store runs UAA with
 *      `authentication.types=OAUTH2`, which means it has no login endpoint at all -- it only
 *      verifies tokens somebody else signed. So this client asks Keycloak for one with the
 *      OAuth 2.0 password grant (the "direct access grant"), which is the flow for a process
 *      with no browser to redirect, and sends it as an ordinary `Bearer` token.
 *   2. The RPC body is always a JSON **array** (a batch), even for a single call, and mutations
 *      must precede queries within one batch.
 */

import { log, describeError } from "../log.js";

/** No outbound call may hang the scan loop (see the Runtime's heartbeat).*/
const REQUEST_TIMEOUT_MS = 30_000;

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
    /**
     * The server's field names, not the obvious ones: `direction` (not `order`) and
     * `nullHandling` (not `nulls`). Getting them wrong is rejected at query time.
     */
    sort?: Array<{
        field: string;
        direction: "ASC" | "DESC";
        /** All three are REQUIRED: the server rejects a null in any of them. */
        nullHandling: "NULLS_FIRST" | "NULLS_LAST";
        ignoreCase: boolean;
    }>;
}

export interface A12ClientOptions {
    baseUrl: string;
    username: string;
    password: string;
    /** Keycloak's base URL, e.g. `http://keycloak:8080` — no realm path. */
    keycloakUrl: string;
    keycloakRealm: string;
    /**
     * The realm client to authenticate against. It must have the direct access grant enabled,
     * which `a12-spa-client` deliberately does not — hence a separate one for the Runtime.
     */
    keycloakClientId: string;
    locale?: string;
    fetchImpl?: typeof fetch;
}

export class A12Client {
    private token: string | undefined;
    private readonly baseUrl: string;
    private readonly keycloakUrl: string;
    private readonly locale: string;
    private readonly doFetch: typeof fetch;

    constructor(private readonly options: A12ClientOptions) {
        this.baseUrl = options.baseUrl.replace(/\/+$/, "");
        this.keycloakUrl = options.keycloakUrl.replace(/\/+$/, "");
        this.locale = options.locale ?? "en";
        this.doFetch = options.fetchImpl ?? fetch;
    }

    /**
     * Keycloak's direct access grant: username and password in, an access token out. The
     * refresh token that comes with it is deliberately ignored — we never proactively renew,
     * because the token outlives many scan intervals and re-authenticating on the first 401 is
     * simpler and cheaper than tracking an expiry we would still have to handle being wrong
     * about.
     */
    async login(): Promise<void> {
        const url = `${this.keycloakUrl}/realms/${this.options.keycloakRealm}/protocol/openid-connect/token`;
        const response = await this.doFetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Accept: "application/json",
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            body: new URLSearchParams({
                grant_type: "password",
                client_id: this.options.keycloakClientId,
                username: this.options.username,
                password: this.options.password,
            }),
        });
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new Error(
                `Login as ${this.options.username} failed: HTTP ${response.status} ${text.slice(0, 200)}`,
            );
        }
        const payload = (await response.json()) as { access_token?: string };
        if (!payload.access_token) {
            throw new Error("Keycloak accepted the credentials but returned no access_token");
        }
        this.token = payload.access_token;
        log.debug("obtained a token from Keycloak", { user: this.options.username });
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
                    // Node's fetch sends `Accept-Language: *` by default, and the Data Service
                    // takes the locale from that header: QUERY then fails with
                    // "Unable to construct query for unsupported locale: *". Pinning it is the
                    // whole fix, and it is invisible until the first query.
                    "Accept-Language": this.locale,
                    "Content-Type": "application/json;charset=utf8",
                    // `Bearer`, not `UAABearer`: the token is Keycloak's, and UAA only mints
                    // (and only recognises) its own under the UAABearer scheme.
                    Authorization: `Bearer ${token}`,
                },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
            const response = await this.doFetch(`${this.baseUrl}/actuator/health`, {
                signal: AbortSignal.timeout(5_000),
            });
            return response.ok;
        } catch (error) {
            log.debug("ThingStore not reachable yet", { error: describeError(error) });
            return false;
        }
    }
}
