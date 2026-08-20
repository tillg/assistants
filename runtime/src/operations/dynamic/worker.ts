/**
 * The worker entry point for a Dynamic Operation (ADR-0025).
 *
 * It receives the compiled body, the arguments, the resolved egress and the timeout through
 * `workerData`; builds the sandbox's one capability object (`host`); runs the Source; and posts back
 * a single result message plus the cache mutations the Source made. It imports `node:vm` (through
 * {@link runInSandbox}), the HTTP client and nothing that reaches the store, the Conversation or the
 * Assistant — a Dynamic Operation reaches an External System and translates the answer, no more.
 */

import { parentPort, workerData } from "node:worker_threads";
import { makeHttpClient } from "./http.js";
import { OperationError, PendingSignal, runInSandbox, type ConsoleSink, type SandboxHost } from "./sandbox.js";
import type { CacheMutation, WorkerRequest } from "./host.js";

async function main(): Promise<void> {
    if (!parentPort) throw new Error("worker started without a parent port");
    const port = parentPort;
    const request = workerData as WorkerRequest;

    const mutations: CacheMutation[] = [];
    const view = new Map(request.cacheSnapshot.map((entry) => [entry.key, entry.value]));
    const cache = {
        get(key: string): unknown {
            return view.get(key);
        },
        set(key: string, value: unknown): void {
            view.set(key, value);
            mutations.push({ op: "set", key, value });
        },
        delete(key: string): void {
            view.delete(key);
            mutations.push({ op: "delete", key });
        },
    };

    const consoleSink: ConsoleSink = (level, args) => {
        port.postMessage({ type: "console", level, args: args.map(safe) });
    };

    const host: SandboxHost = {
        http: makeHttpClient(request.egress, request.egressName, request.maxBodyBytes, request.timeoutMs),
        cache,
        context: { idempotencyKey: request.ctx.idempotencyKey },
        error(message: string): never {
            throw new OperationError(message);
        },
        pending(signal): PendingSignal {
            return new PendingSignal(signal.waitingFor, signal.wakeAt, signal.note);
        },
    };

    const result = await runInSandbox(
        request.code,
        host,
        request.args,
        request.mode,
        request.timeoutMs,
        consoleSink,
    );
    port.postMessage({ type: "result", result, cacheMutations: mutations });
}

/** A value safe to structured-clone across the port: strings pass, everything else is stringified. */
function safe(value: unknown): string {
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}

void main().catch((error: unknown) => {
    parentPort?.postMessage({
        type: "result",
        result: {
            kind: "error",
            message: "The Operation failed.",
            detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
            exposed: false,
        },
        cacheMutations: [],
    });
});
