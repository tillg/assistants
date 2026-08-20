/**
 * `host.cache` — the per-egress, TTL'd, host-side store the chart of accounts lives in now that
 * `FireflyConnector`'s instance field is gone (ADR-0025). Two properties the old field had must
 * survive the move, or the cache is a regression: it is shared across executions (the field was
 * process-lifetime), and it can be invalidated on write (`createAccount` cleared it). The TTL is
 * new — a deliberate staleness ceiling the old code lacked.
 */

import { describe, expect, it } from "vitest";
import { HostCache, OperationHost } from "../../src/operations/dynamic/host.js";
import type { DynamicOperationConfig } from "../../src/config.js";
import type { OperationContext, OperationOutcome } from "../../src/operations/registry.js";

describe("HostCache", () => {
    it("returns a value that was set, and undefined for a miss", () => {
        const cache = new HostCache(1000, () => 0);
        cache.set("books", "chart", [1, 2, 3]);
        expect(cache.get("books", "chart")).toEqual([1, 2, 3]);
        expect(cache.get("books", "absent")).toBeUndefined();
    });

    it("does not share entries between two egresses", () => {
        const cache = new HostCache(1000, () => 0);
        cache.set("books", "chart", "A");
        expect(cache.get("bank", "chart")).toBeUndefined();
    });

    it("treats an entry past the TTL as a miss", () => {
        let now = 0;
        const cache = new HostCache(1000, () => now);
        cache.set("books", "chart", "A");
        now = 999;
        expect(cache.get("books", "chart")).toBe("A");
        now = 1001;
        expect(cache.get("books", "chart")).toBeUndefined();
    });

    it("evicts on delete", () => {
        const cache = new HostCache(1000, () => 0);
        cache.set("books", "chart", "A");
        cache.delete("books", "chart");
        expect(cache.get("books", "chart")).toBeUndefined();
    });
});

function config(): DynamicOperationConfig {
    return {
        timeoutMs: 20_000,
        maxBodyBytes: 4 * 1024 * 1024,
        memoryMb: 128,
        cacheTtlMs: 300_000,
        egresses: {
            test: { url: "http://127.0.0.1:9/", token: "t" },
            other: { url: "http://127.0.0.1:9/", token: "t" },
        },
    };
}

const context = { idempotencyKey: "conv:1" } as unknown as OperationContext;

async function run(host: OperationHost, source: string, egress: string): Promise<OperationOutcome | undefined> {
    return host.run(host.compile(source), "execute", {}, context, { key: "test.op", egress });
}

describe("host.cache across executions", () => {
    it("is shared: one execution reads what an earlier one wrote", async () => {
        const host = new OperationHost(config());
        await run(host, "function execute() { host.cache.set('chart', { a: 1 }); return 1; }", "test");
        const outcome = await run(host, "function execute() { return host.cache.get('chart'); }", "test");
        expect(outcome).toEqual({ kind: "value", value: { a: 1 } });
    });

    it("is per egress: another egress does not see it", async () => {
        const host = new OperationHost(config());
        await run(host, "function execute() { host.cache.set('chart', 'A'); return 1; }", "test");
        const outcome = await run(host, "function execute() { return host.cache.get('chart') ?? 'miss'; }", "other");
        expect(outcome).toEqual({ kind: "value", value: "miss" });
    });

    it("honours delete from a later execution — the createAccount invalidation", async () => {
        const host = new OperationHost(config());
        await run(host, "function execute() { host.cache.set('chart', 'stale'); return 1; }", "test");
        await run(host, "function execute() { host.cache.delete('chart'); return 1; }", "test");
        const outcome = await run(host, "function execute() { return host.cache.get('chart') ?? 'miss'; }", "test");
        expect(outcome).toEqual({ kind: "value", value: "miss" });
    });
});
