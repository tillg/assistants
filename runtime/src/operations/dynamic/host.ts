/**
 * The Operation Host — the main-thread half that runs a Dynamic Operation's Source (ADR-0025).
 *
 * It compiles the Source (via {@link compile}), spawns a worker per execution with the code, the
 * arguments and the *resolved* egress credential in `workerData`, bounds it in time (a terminate
 * timer) and memory (`resourceLimits`), and translates the one message that comes back into the same
 * {@link OperationOutcome} a built-in returns. It is the only component that ever holds both a
 * credential and someone else's source, and it never lets the credential into the sandbox.
 *
 * `host.cache` lives here, on the main thread, so it survives between worker spawns: the snapshot for
 * an egress goes out in `workerData`, and the mutations the Source made come back and are applied.
 */

import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { log } from "../../log.js";
import type { DynamicOperationConfig, EgressConfig } from "../../config.js";
import { clampTimeoutMs } from "../../config.js";
import type { OperationContext, OperationOutcome } from "../registry.js";
import { compile, type CompiledModule, type OperationLanguage } from "./compile.js";
import type { EgressCredential } from "./http.js";
import type { SandboxMode, SandboxResult } from "./sandbox.js";

/** Extra wall-clock beyond the execution ceiling, to let a worker boot before the terminate fires. */
const SPAWN_ALLOWANCE_MS = 3_000;

export type CacheMutation = { op: "set"; key: string; value: unknown } | { op: "delete"; key: string };

/** Everything the worker needs, structured-cloned into it. The credential is here and nowhere else. */
export interface WorkerRequest {
    code: string;
    args: Record<string, unknown>;
    ctx: { idempotencyKey: string };
    mode: SandboxMode;
    egressName: string;
    egress?: EgressCredential;
    timeoutMs: number;
    maxBodyBytes: number;
    cacheSnapshot: Array<{ key: string; value: unknown }>;
    operationKey: string;
}

export type WorkerMessage =
    | { type: "console"; level: "debug" | "info" | "warn" | "error"; args: unknown[] }
    | { type: "result"; result: SandboxResult; cacheMutations: CacheMutation[] };

interface CacheEntry {
    value: unknown;
    expiresAt: number;
}

/**
 * A host-side, per-egress, TTL'd key/value store — where the chart of accounts lives now that
 * `FireflyConnector`'s instance field is gone. Two things had to survive that move: the field had no
 * staleness bound, so the TTL is a new and deliberate ceiling; and it was invalidated on write, so
 * {@link delete} is how `createAccount`'s Source keeps a freshly made account resolvable before the
 * TTL lapses.
 */
export class HostCache {
    private readonly store = new Map<string, Map<string, CacheEntry>>();

    constructor(
        private readonly ttlMs: number,
        private readonly clock: () => number = () => Date.now(),
    ) {}

    private forEgress(egress: string): Map<string, CacheEntry> {
        let map = this.store.get(egress);
        if (!map) {
            map = new Map();
            this.store.set(egress, map);
        }
        return map;
    }

    /** The live (non-expired) entries for one egress, as a plain array for `workerData`. */
    snapshot(egress: string): Array<{ key: string; value: unknown }> {
        const now = this.clock();
        const entries: Array<{ key: string; value: unknown }> = [];
        for (const [key, entry] of this.forEgress(egress)) {
            if (entry.expiresAt > now) entries.push({ key, value: entry.value });
        }
        return entries;
    }

    applyMutations(egress: string, mutations: CacheMutation[]): void {
        const map = this.forEgress(egress);
        const expiresAt = this.clock() + this.ttlMs;
        for (const mutation of mutations) {
            if (mutation.op === "set") map.set(mutation.key, { value: mutation.value, expiresAt });
            else map.delete(mutation.key);
        }
    }

    get(egress: string, key: string): unknown {
        const entry = this.forEgress(egress).get(key);
        if (!entry) return undefined;
        if (entry.expiresAt <= this.clock()) {
            this.forEgress(egress).delete(key);
            return undefined;
        }
        return entry.value;
    }

    set(egress: string, key: string, value: unknown): void {
        this.forEgress(egress).set(key, { value, expiresAt: this.clock() + this.ttlMs });
    }

    delete(egress: string, key: string): void {
        this.forEgress(egress).delete(key);
    }
}

export class OperationHost {
    readonly cache: HostCache;

    constructor(
        private readonly config: DynamicOperationConfig,
        clock: () => number = () => Date.now(),
    ) {
        this.cache = new HostCache(config.cacheTtlMs, clock);
    }

    /** Compile a Source, cached by its sha256. Throws {@link CompileError} the registry catches. */
    compile(source: string, language?: OperationLanguage): CompiledModule {
        return compile(source, language);
    }

    /** Is this egress name defined in configuration? A grant naming an undefined one is dropped. */
    hasEgress(egress: string | undefined): boolean {
        return egress !== undefined && egress !== "" && this.config.egresses[egress] !== undefined;
    }

    /**
     * Does the Source declare a `reconcile`? A static scan, not an evaluation: the main thread never
     * runs Source. It drives an advisory warning only (a `mutating` Dynamic Operation with no
     * `reconcile` is a double booking waiting for a crash), so a rare miss costs a spurious warning,
     * never correctness.
     */
    declaresReconcile(module: CompiledModule): boolean {
        return /\bfunction\s+reconcile\b/.test(module.code) || /\breconcile\s*=/.test(module.code);
    }

    /**
     * Run one invocation. Returns an {@link OperationOutcome} for `execute`; for `reconcile`,
     * `undefined` when the Source declares none — which is exactly the "cannot tell" the recovery
     * path escalates on.
     */
    async run(
        module: CompiledModule,
        mode: SandboxMode,
        args: Record<string, unknown>,
        context: OperationContext,
        operation: { key: string; egress?: string; timeoutMs?: number },
    ): Promise<OperationOutcome | undefined> {
        const egressName = operation.egress ?? "";
        const egressConfig = this.config.egresses[egressName];
        let credential: EgressCredential | undefined;
        if (egressConfig) {
            try {
                credential = { url: egressConfig.url, token: resolveEgressToken(egressConfig) };
            } catch (error) {
                log.error("could not resolve the credential for an egress", {
                    operation: operation.key,
                    egress: egressName,
                    detail: error instanceof Error ? error.message : String(error),
                });
                return { kind: "error", message: `no credential is available for egress "${egressName}"` };
            }
        }

        const timeoutMs = clampTimeoutMs(this.config, operation.timeoutMs);
        const request: WorkerRequest = {
            code: module.code,
            args,
            // A client-readable Operation is called through the inbound door with no context at all
            // (ADR-0023): no Conversation, no idempotency key. `context` is therefore optional here,
            // and a Source that reaches for the key on that path gets an empty string, not a crash.
            ctx: { idempotencyKey: context?.idempotencyKey ?? "" },
            mode,
            egressName,
            ...(credential ? { egress: credential } : {}),
            timeoutMs,
            maxBodyBytes: this.config.maxBodyBytes,
            cacheSnapshot: this.cache.snapshot(egressName),
            operationKey: operation.key,
        };

        const outcome = await this.spawn(request, timeoutMs, operation.key, egressName);
        return this.translate(outcome, mode, operation.key);
    }

    private spawn(
        request: WorkerRequest,
        timeoutMs: number,
        operationKey: string,
        egressName: string,
    ): Promise<{ result: SandboxResult; cacheMutations: CacheMutation[] }> {
        return new Promise((resolve) => {
            let worker: Worker;
            try {
                worker = makeWorker(request, this.config.memoryMb);
            } catch (error) {
                // A failed spawn (bad path, impossible resourceLimits) is an outcome, not a throw that
                // escapes `run` and rejects the Operation call.
                log.error("could not spawn a Dynamic Operation's worker", {
                    operation: operationKey,
                    detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
                });
                resolve({ result: { kind: "error", message: "The Operation failed.", exposed: false }, cacheMutations: [] });
                return;
            }
            let settled = false;
            const finish = (result: SandboxResult, cacheMutations: CacheMutation[]) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (cacheMutations.length > 0) this.cache.applyMutations(egressName, cacheMutations);
                // terminate() returns a promise; discard its value but never let a rejection escape.
                void worker.terminate().catch(() => {});
                resolve({ result, cacheMutations });
            };

            const timer = setTimeout(() => {
                finish({ kind: "error", message: "The Operation timed out.", exposed: false }, []);
            }, timeoutMs + SPAWN_ALLOWANCE_MS);

            worker.on("message", (message: WorkerMessage) => {
                if (message.type === "console") {
                    log[message.level](`[${operationKey}] ${message.args.map(stringify).join(" ")}`, {
                        operation: operationKey,
                    });
                    return;
                }
                finish(message.result, message.cacheMutations);
            });
            worker.on("error", (error) => {
                log.error("a Dynamic Operation's worker failed", {
                    operation: operationKey,
                    detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
                });
                finish({ kind: "error", message: "The Operation failed.", exposed: false }, []);
            });
            worker.on("exit", () => {
                finish({ kind: "error", message: "The Operation failed.", exposed: false }, []);
            });
        });
    }

    private translate(
        outcome: { result: SandboxResult },
        mode: SandboxMode,
        operationKey: string,
    ): OperationOutcome | undefined {
        const result = outcome.result;
        switch (result.kind) {
            case "value":
                return { kind: "value", value: result.value };
            case "pending":
                return {
                    kind: "pending",
                    waitingFor: result.waitingFor,
                    ...(result.wakeAt !== undefined ? { wakeAt: result.wakeAt } : {}),
                    ...(result.note !== undefined ? { note: result.note } : {}),
                };
            case "error":
                if (result.detail) {
                    log.error("a Dynamic Operation raised an error", {
                        operation: operationKey,
                        detail: result.detail,
                    });
                }
                return { kind: "error", message: result.message };
            case "no-function":
                if (mode === "reconcile") return undefined;
                return {
                    kind: "error",
                    message: `Operation ${operationKey} declares no execute function`,
                };
        }
    }
}

/** `token` wins; otherwise the file is read now, as the FireflyConnector reads its own. */
function resolveEgressToken(egress: EgressConfig): string {
    if (egress.token) return egress.token;
    if (egress.tokenFile) return readFileSync(egress.tokenFile, "utf8").trim();
    return "";
}

/**
 * Spawn the worker across all three environments: compiled (`worker.js`, plain), and dev/test
 * (`worker.ts`, through a `tsx` register bootstrap — tsx is a devDependency, pruned from the image,
 * and the `.ts` branch never runs there because the code is `.js`).
 */
function makeWorker(request: WorkerRequest, memoryMb: number): Worker {
    const options = {
        workerData: request,
        resourceLimits: { maxOldGenerationSizeMb: memoryMb },
    } as const;
    if (import.meta.url.endsWith(".ts")) {
        const workerTs = new URL("./worker.ts", import.meta.url).href;
        const boot = `import { register } from 'tsx/esm/api'; register(); await import(${JSON.stringify(workerTs)});`;
        return new Worker(boot, { eval: true, ...options });
    }
    return new Worker(new URL("./worker.js", import.meta.url), options);
}

function stringify(value: unknown): string {
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}
