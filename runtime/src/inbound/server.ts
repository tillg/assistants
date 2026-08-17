/**
 * The door outward, seen from inside (ADR-0023).
 *
 * The Runtime is the one component that talks to External Systems, and this is how the *client* gets
 * to ask it something. One route, read-only, on the compose network: the browser's own authentication
 * happened at the server, against Keycloak, and what arrives here is the server saying *"this User is
 * allowed, and this Operation is one you offer"*.
 *
 * `index.ts` used to open with *"There is nothing else. No HTTP server, no queue, no scheduler — the
 * ThingStore is the only Authority for pending work"*. That sentence is narrowed rather than
 * withdrawn: the ThingStore is still the only Authority for **pending work**, and nothing about
 * pending work comes through here. This carries questions about foreign systems, which the store has
 * no opinion on.
 *
 * **`node:http`, no framework.** One route and a JSON body is twenty lines of standard library, and
 * the Runtime's job is a scan loop — adding Express to it would be a dependency, a lockfile change and
 * a supply-chain surface for something that does not need one.
 *
 * **What this deliberately skips.** Executing an Implementation directly bypasses `grantedTo()` (the
 * ADR-0010 grant filter and the catalogue's `enabled` check), `LoopDriver.gateOnApproval()`, the
 * intent log and the idempotency-key convention. Every one of those exists to make *writes* safe, and
 * the gate is what guarantees there are none: see `gate.ts`, which is the whole of the reasoning.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

import { decide } from "./gate.js";
import { eq, path as fieldPath, SPECS, type ThingRepository } from "../a12/things.js";
import { describeError, log } from "../log.js";
import type { Operation } from "../domain/types.js";
import type { OperationContext, OperationRegistry } from "../operations/registry.js";

/** A body larger than this is not a call this route has any use for. */
const MAX_BODY_BYTES = 64 * 1024;

export interface InboxOptions {
    /** `0` lets the operating system pick — which is what the tests use. */
    readonly port: number;
    readonly secret: string;
    readonly allowlist: readonly string[];
    readonly registry: OperationRegistry;
    /**
     * Optional, and only for the `Enabled` check — the one part of the gate that is legitimately the
     * User's decision rather than the code's. Omitted in the tests that are about the gate's other
     * three checks, which have nothing to do with the store.
     */
    readonly things?: ThingRepository;
}

export interface Inbox {
    /** The port actually bound, which is what `port: 0` makes worth returning. */
    readonly port: number;
    close(): Promise<void>;
}

/**
 * There is no Conversation behind a client call, and inventing one would put a fabricated
 * conversation id into an idempotency key. `clientReadable` is the promise that the Operation does
 * not look — `clientReadable.test.ts` is what keeps that promise honest.
 */
const NO_CONTEXT = undefined as unknown as OperationContext;

export async function startInbox(options: InboxOptions): Promise<Inbox> {
    const server = createServer((request, response) => {
        void handle(request, response, options).catch((error: unknown) => {
            // A handler that throws must not take the listener with it — the scan loop is in this
            // process, and its job matters more than this one's.
            log.error("the inbox failed to handle a request", { error: describeError(error) });
            send(response, 500, { ok: false, reason: "internal" });
        });
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, () => resolve());
    });

    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : options.port;
    log.info("the door outward is open", { port, allows: options.allowlist.length });

    return { port, close: () => close(server) };
}

async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    options: InboxOptions,
): Promise<void> {
    const url = new URL(request.url ?? "/", "http://runtime");

    // Before the secret check: a health probe that needed a credential would be a probe nobody runs.
    // It executes nothing and reveals nothing.
    if (request.method === "GET" && url.pathname === "/healthz") {
        send(response, 200, { ok: true });
        return;
    }

    const prefix = "/operations/";
    if (request.method !== "POST" || !url.pathname.startsWith(prefix)) {
        send(response, 404, { ok: false, reason: "no-such-route" });
        return;
    }

    if (!secretMatches(request.headers["x-runtime-secret"], options.secret)) {
        // Before parsing anything and before consulting the gate: an unauthenticated caller learns
        // nothing about which Operations exist, or even whether the name it guessed is one.
        send(response, 401, { ok: false, reason: "unauthenticated" });
        return;
    }

    const key = decodeURIComponent(url.pathname.slice(prefix.length));
    const verdict = decide(key, options.registry, options.allowlist);
    if (!verdict.allowed) {
        log.warn("the inbox refused a call", { operation: key, reason: verdict.reason });
        send(response, 403, { ok: false, reason: verdict.reason });
        return;
    }

    // The fourth check, and the only one that is not code: an Operation the User has switched off is
    // off everywhere, not merely invisible to the Assistants. Read from the Thing because that is the
    // one thing on the Operation the Thing is genuinely the Authority for (ADR-0019) — unlike
    // `Mutating`, which `gate.ts` explains at length is never trusted from there.
    if (options.things && !(await isEnabled(options.things, key))) {
        log.warn("the inbox refused a call", { operation: key, reason: "not-allowed" });
        send(response, 403, { ok: false, reason: "not-allowed" });
        return;
    }

    let args: Record<string, unknown>;
    try {
        args = parseArgs(await readBody(request));
    } catch (error) {
        send(response, 400, { ok: false, reason: "bad-request" });
        log.warn("the inbox was sent something it could not read", { error: describeError(error) });
        return;
    }

    try {
        const outcome = await verdict.implementation.execute(args, NO_CONTEXT);
        send(response, 200, { ok: true, outcome });
    } catch (error) {
        // The External System failed, which is a fact about the world rather than a refusal — and
        // distinguishable from one, so that "Firefly is down" and "you may not ask that" are never
        // the same line in a log.
        log.warn("an Operation called through the inbox failed", {
            operation: key,
            error: describeError(error),
        });
        send(response, 502, { ok: false, reason: "operation-failed" });
    }
}

/**
 * Has the User switched this Operation off?
 *
 * `enabled` is tri-state and unset reads as enabled, so only an explicit `false` closes the door —
 * the same reading `grantedTo()` gives it for the Assistants.
 *
 * A store failure is treated as **not enabled**. That is the uncomfortable direction and the right
 * one: this is a check that grants access, so "I could not find out" must not mean "go ahead". The
 * cost is that an unreachable store greys two Tiles, which is honest anyway.
 */
async function isEnabled(things: ThingRepository, key: string): Promise<boolean> {
    try {
        const found = await things.search<Operation>(
            SPECS.Operation_DM,
            eq(fieldPath(SPECS.Operation_DM, "key"), key),
            2,
        );
        const operation = found[0];
        return operation !== undefined && operation.data.enabled !== false;
    } catch (error) {
        log.warn("could not read an Operation to check whether it is switched on", {
            operation: key,
            error: describeError(error),
        });
        return false;
    }
}

/** Constant-time, and length-safe: `timingSafeEqual` throws on a length mismatch. */
function secretMatches(presented: string | string[] | undefined, expected: string): boolean {
    if (typeof presented !== "string" || expected === "") return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

function parseArgs(body: string): Record<string, unknown> {
    const parsed: unknown = body === "" ? {} : JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) throw new Error("body is not an object");
    const args = (parsed as { args?: unknown }).args ?? {};
    if (typeof args !== "object" || args === null) throw new Error("args is not an object");
    return args as Record<string, unknown>;
}

function readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = "";
        request.on("data", (chunk: Buffer) => {
            body += chunk.toString("utf8");
            if (body.length > MAX_BODY_BYTES) {
                reject(new Error("body too large"));
                request.destroy();
            }
        });
        request.on("end", () => resolve(body));
        request.on("error", reject);
    });
}

function send(response: ServerResponse, status: number, body: unknown): void {
    if (response.writableEnded) return;
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
}

function close(server: Server): Promise<void> {
    return new Promise((resolve) => {
        // `close` waits for open connections; keep-alive sockets would otherwise hold SIGTERM open
        // for as long as the client cared to.
        server.closeAllConnections();
        server.close(() => resolve());
    });
}
