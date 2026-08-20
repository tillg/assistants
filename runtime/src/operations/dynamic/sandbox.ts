/**
 * The curated global object a Dynamic Operation's Source runs inside (ADR-0025).
 *
 * `vm.runInNewContext(code, globals, { timeout })` gives the Source a fresh realm whose intrinsics
 * are its own. What a bare context does *not* carry is already most of the job — `process`,
 * `require`, `fetch`, `Buffer`, `setTimeout` are simply absent — so this module's work is the two
 * remaining edges: strip `WebAssembly` (a compute surface the Source has no use for), and inject
 * the handful of standard constructors a bare context omits (`URL`, `URLSearchParams`,
 * `TextEncoder`/`Decoder`) plus the single capability object, `host`.
 *
 * **This is containment, not a security boundary.** `host` and the injected constructors come from
 * the worker's realm, so `host.error.constructor` is that realm's `Function` and a determined caller
 * could reach it. The boundary that keeps an Assistant out of here is the store's write authority
 * (ADR-0025); the sandbox's job is to keep an *honest mistake* — an accidental `fs`, a runaway loop
 * — from being a Runtime outage, and it is not claimed to do more.
 */

import vm from "node:vm";

/** The error a Source throws (via `host.error`) whose message the model is allowed to read. */
export class OperationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "OperationError";
    }
}

/** What `host.pending(...)` returns: a Source may answer *not now*, and this is how it says so. */
export class PendingSignal {
    constructor(
        readonly waitingFor: "user" | "tool" | "assistant",
        readonly wakeAt?: string,
        readonly note?: string,
    ) {}
}

/** The one capability object handed to the Source. Built by the worker; opaque to this module. */
export interface SandboxHost {
    http: unknown;
    cache: unknown;
    context: unknown;
    error(message: string): never;
    pending(signal: { waitingFor: "user" | "tool" | "assistant"; wakeAt?: string; note?: string }): PendingSignal;
}

export type SandboxMode = "execute" | "reconcile";

export type ConsoleSink = (level: "debug" | "info" | "warn" | "error", args: unknown[]) => void;

/** The outcome of one sandboxed invocation, in the worker's own vocabulary. */
export type SandboxResult =
    | { kind: "value"; value: unknown }
    | { kind: "pending"; waitingFor: "user" | "tool" | "assistant"; wakeAt?: string; note?: string }
    /** The requested function (`execute`, or `reconcile`) was not declared by the Source. */
    | { kind: "no-function" }
    /**
     * `exposed` distinguishes a message the model may read (an `OperationError` the Source threw)
     * from one it may not (any other throw): `message` is safe either way, and `detail` carries the
     * stack for the log and never for the transcript (Result Contract, domain.md).
     */
    | { kind: "error"; message: string; detail?: string; exposed: boolean };

function makeConsole(sink: ConsoleSink): Console {
    const at = (level: "debug" | "info" | "warn" | "error") => (...args: unknown[]) => sink(level, args);
    // Only the four levels the structured logger has; the rest map onto them.
    return {
        log: at("info"),
        info: at("info"),
        debug: at("debug"),
        warn: at("warn"),
        error: at("error"),
    } as unknown as Console;
}

/**
 * Run one invocation of a compiled Source. The code declares `execute` and maybe `reconcile`; this
 * evaluates it into a fresh context, then calls the requested function with `(args, host)`.
 *
 * The `timeout` guards the *synchronous* prefix — a `while (true)` before the first `await`. What it
 * cannot catch (a never-resolving `await`, a busy loop after one) is the worker's `terminate()`'s
 * job, which is why both layers exist (architecture.md).
 */
export async function runInSandbox(
    code: string,
    host: SandboxHost,
    args: Record<string, unknown>,
    mode: SandboxMode,
    timeoutMs: number,
    onConsole: ConsoleSink,
): Promise<SandboxResult> {
    const context: Record<string, unknown> = {
        host,
        console: makeConsole(onConsole),
        URL,
        URLSearchParams,
        TextEncoder,
        TextDecoder,
    };
    vm.createContext(context);
    // Strip the compute surface the Source has no use for, from inside the realm, before its code
    // runs. `globalThis` is left pointing at the sandbox's own global — it does not reach the host.
    vm.runInContext("try { WebAssembly = undefined; } catch (_) {}", context);

    try {
        new vm.Script(code).runInContext(context, { timeout: timeoutMs });
    } catch (error) {
        return errorResult(error);
    }

    const fn = context[mode];
    if (typeof fn !== "function") return { kind: "no-function" };

    try {
        const returned: unknown = await (fn as (a: unknown, h: unknown) => unknown)(args, host);
        if (returned instanceof PendingSignal) {
            return {
                kind: "pending",
                waitingFor: returned.waitingFor,
                ...(returned.wakeAt !== undefined ? { wakeAt: returned.wakeAt } : {}),
                ...(returned.note !== undefined ? { note: returned.note } : {}),
            };
        }
        return { kind: "value", value: returned };
    } catch (error) {
        return errorResult(error);
    }
}

/**
 * An `OperationError` the Source threw is the model's to read; anything else is a fault whose
 * message says only that the Operation failed, with the stack going to the log alone.
 */
function errorResult(error: unknown): SandboxResult {
    if (error instanceof OperationError) {
        return { kind: "error", message: error.message, exposed: true };
    }
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    return { kind: "error", message: "The Operation failed.", detail, exposed: false };
}
