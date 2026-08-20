/**
 * The sandbox, exercised end to end through the Operation Host (ADR-0025).
 *
 * These run real workers: a curated global object, a hard timeout that `terminate()` enforces, a
 * memory ceiling, and the Result Contract's translation of what the Source returns or throws. The
 * sandbox is containment, not a security boundary — what is asserted here is that an *honest
 * mistake* (a loop, a runaway allocation, a reach for `fs`) becomes an error outcome rather than a
 * Runtime outage, and that a fault's detail reaches the log and never the transcript.
 */

import { describe, expect, it, vi } from "vitest";
import { log } from "../../src/log.js";
import { OperationHost } from "../../src/operations/dynamic/host.js";
import type { DynamicOperationConfig } from "../../src/config.js";
import type { OperationContext, OperationOutcome } from "../../src/operations/registry.js";
import type { SandboxMode } from "../../src/operations/dynamic/sandbox.js";

function config(overrides: Partial<DynamicOperationConfig> = {}): DynamicOperationConfig {
    return {
        timeoutMs: 20_000,
        maxBodyBytes: 4 * 1024 * 1024,
        memoryMb: 128,
        cacheTtlMs: 300_000,
        egresses: { test: { url: "http://127.0.0.1:9/", token: "s3cret-token" } },
        ...overrides,
    };
}

const context = { idempotencyKey: "conv:1" } as unknown as OperationContext;

async function run(
    host: OperationHost,
    source: string,
    options: { mode?: SandboxMode; args?: Record<string, unknown>; egress?: string; timeoutMs?: number } = {},
): Promise<OperationOutcome | undefined> {
    const module = host.compile(source);
    return host.run(module, options.mode ?? "execute", options.args ?? {}, context, {
        key: "test.op",
        ...(options.egress !== undefined ? { egress: options.egress } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
}

describe("the curated global object", () => {
    it("has no process, require, fetch or Buffer", async () => {
        const host = new OperationHost(config());
        const outcome = await run(
            host,
            "function execute() { return [typeof process, typeof require, typeof fetch, typeof Buffer].join(','); }",
        );
        expect(outcome).toEqual({ kind: "value", value: "undefined,undefined,undefined,undefined" });
    });

    it("routes console.log to the structured logger with the Operation's key", async () => {
        const host = new OperationHost(config());
        const info = vi.spyOn(log, "info").mockImplementation(() => {});
        try {
            await run(host, "function execute() { console.log('chart', 3); return 1; }");
            expect(info).toHaveBeenCalledWith(
                expect.stringContaining("[test.op] chart 3"),
                expect.objectContaining({ operation: "test.op" }),
            );
        } finally {
            info.mockRestore();
        }
    });
});

describe("the Result Contract", () => {
    it("round-trips a returned value", async () => {
        const host = new OperationHost(config());
        const outcome = await run(host, "function execute(args) { return { doubled: args.n * 2, list: [1, 2] }; }", {
            args: { n: 21 },
        });
        expect(outcome).toEqual({ kind: "value", value: { doubled: 42, list: [1, 2] } });
    });

    it("turns a thrown OperationError into an error outcome the model reads", async () => {
        const host = new OperationHost(config());
        const outcome = await run(host, "function execute() { host.error('that account does not exist'); }");
        expect(outcome).toEqual({ kind: "error", message: "that account does not exist" });
    });

    it("hides any other throw's detail from the transcript but logs it", async () => {
        const host = new OperationHost(config());
        const error = vi.spyOn(log, "error").mockImplementation(() => {});
        try {
            const outcome = await run(host, "function execute() { throw new Error('secret internal boom'); }");
            expect(outcome).toEqual({ kind: "error", message: "The Operation failed." });
            expect((outcome as { message: string }).message).not.toContain("boom");
            expect(error).toHaveBeenCalledWith(
                "a Dynamic Operation raised an error",
                expect.objectContaining({ detail: expect.stringContaining("boom") }),
            );
        } finally {
            error.mockRestore();
        }
    });

    it("turns host.pending(...) into a pending outcome", async () => {
        const host = new OperationHost(config());
        const outcome = await run(
            host,
            "function execute() { return host.pending({ waitingFor: 'user', note: 'ask them' }); }",
        );
        expect(outcome).toEqual({ kind: "pending", waitingFor: "user", note: "ask them" });
    });

    it("reports a missing execute function as an error", async () => {
        const host = new OperationHost(config());
        const outcome = await run(host, "function reconcile() { return { kind: 'value', value: 1 }; }");
        expect(outcome).toEqual({ kind: "error", message: "Operation test.op declares no execute function" });
    });

    it("returns undefined when reconcile is asked for and the Source declares none", async () => {
        const host = new OperationHost(config());
        const outcome = await run(host, "function execute() { return 1; }", { mode: "reconcile" });
        expect(outcome).toBeUndefined();
    });
});

describe("containment", () => {
    it("terminates an infinite loop and answers with an error, not a hang", { timeout: 15_000 }, async () => {
        const host = new OperationHost(config({ timeoutMs: 400 }));
        const outcome = await run(host, "function execute() { while (true) {} }");
        expect(outcome?.kind).toBe("error");
    });

    it("terminates a runaway allocation", { timeout: 20_000 }, async () => {
        const host = new OperationHost(config({ memoryMb: 32, timeoutMs: 8_000 }));
        const outcome = await run(
            host,
            "function execute() { const a = []; for (;;) { a.push(new Array(1000000).fill(7)); } }",
        );
        expect(outcome?.kind).toBe("error");
    });
});
