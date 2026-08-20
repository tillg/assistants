/**
 * The injected HTTP client — the only outward capability a Dynamic Operation is granted (ADR-0025).
 *
 * It runs in the worker, not the sandbox: the sandbox holds `host.http`, and the credential the
 * client attaches is read from `workerData` and never enters the sandbox's realm. `path` is joined
 * onto the egress base URL and each segment re-encoded, so a `&` or `?` in a segment stays in the
 * path and cannot steer the request; `query` is built separately with `URLSearchParams`.
 *
 * It **never throws on an HTTP status** — a 404 answers `{ status: 404, ok: false }` and the Source
 * decides what that means (Result Contract). It throws only for what the Source got wrong (an
 * unknown egress, an absolute URL) or for a foreign system trying to exhaust the process (a body
 * over the cap), and those throws are `OperationError`s whose message the model may read.
 */

import { OperationError } from "./sandbox.js";

/** The resolved egress the worker was handed: base URL and the credential to attach. */
export interface EgressCredential {
    readonly url: string;
    readonly token: string;
}

export interface HttpRequest {
    method?: string;
    path: string;
    query?: Record<string, string | number | boolean>;
    body?: unknown;
    headers?: Record<string, string>;
}

export interface HttpResponse {
    readonly status: number;
    readonly ok: boolean;
    readonly body: unknown;
}

export interface HttpClient {
    request(request: HttpRequest): Promise<HttpResponse>;
}

const ABSOLUTE = /^[a-z][a-z0-9+.-]*:\/\/|^\/\//i;

export function makeHttpClient(
    egress: EgressCredential | undefined,
    egressName: string,
    maxBodyBytes: number,
    timeoutMs: number,
    fetchImpl: typeof fetch = fetch,
): HttpClient {
    return {
        async request(request: HttpRequest): Promise<HttpResponse> {
            if (!egress) {
                throw new OperationError(
                    `egress "${egressName}" is not configured — no base URL or credential is bound to it`,
                );
            }
            const path = request.path ?? "";
            if (ABSOLUTE.test(path)) {
                throw new OperationError(
                    `path "${path}" is absolute; a Dynamic Operation may only reach its bound egress, ` +
                        `so give a path like "/api/v1/accounts", not a full URL`,
                );
            }

            const encodedPath =
                "/" +
                path
                    .split("/")
                    .filter((segment) => segment !== "")
                    .map((segment) => encodeURIComponent(segment))
                    .join("/");
            const url = new URL(egress.url.replace(/\/+$/, "") + encodedPath);
            for (const [key, value] of Object.entries(request.query ?? {})) {
                url.searchParams.set(key, String(value));
            }

            const method = (request.method ?? "GET").toUpperCase();
            const hasBody = request.body !== undefined;
            const response = await fetchImpl(url, {
                method,
                headers: {
                    Authorization: `Bearer ${egress.token}`,
                    Accept: "application/json",
                    ...(hasBody ? { "Content-Type": "application/json" } : {}),
                    ...(request.headers ?? {}),
                },
                // Bound the outbound call by the Operation's own budget: a service that accepts the
                // connection and never answers would otherwise wedge the worker until the host's
                // terminate() fires (timeoutMs + spawn allowance). Aborting at timeoutMs fails faster
                // and hands the sandbox an AbortError to translate, rather than a hard terminate.
                signal: AbortSignal.timeout(timeoutMs),
                ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
            });

            const text = await readCapped(response, maxBodyBytes, egressName);
            return { status: response.status, ok: response.ok, body: parseBody(text, response) };
        },
    };
}

/**
 * Read the body, refusing once it passes the cap rather than buffering all of it first: a foreign
 * system must not be able to exhaust the process that runs the scan loop by answering with gigabytes.
 */
async function readCapped(response: Response, maxBodyBytes: number, egressName: string): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBodyBytes) {
            await reader.cancel();
            throw new OperationError(
                `response from egress "${egressName}" exceeds the ${maxBodyBytes}-byte cap`,
            );
        }
        chunks.push(value);
    }
    return new TextDecoder().decode(concat(chunks, total));
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

/** JSON when the answer says it is JSON (or parses as such); the raw text otherwise. */
function parseBody(text: string, response: Response): unknown {
    if (text === "") return undefined;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("json")) {
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    }
    return text;
}
