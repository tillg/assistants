/**
 * The Operation registry.
 *
 * Two rules from the ADRs are enforced here rather than hoped for:
 *
 *   - **ADR-0010**: an Assistant may use only the Operations its `grants[]` declares. The registry
 *     filters the schemas offered to the LLM by that list, so an undeclared Operation is not
 *     merely refused — it is invisible. (It is refused as well, because "should be unreachable"
 *     is a claim worth testing.) Since ADR-0019 the rule is a **conjunction**: the grant must name
 *     an Operation the catalogue holds and has switched on, and a registered Implementation.
 *   - **The idempotency contract**: every Operation is either read-only or idempotent under a
 *     caller-supplied key. No Operation may be both mutating and unkeyed. `mutating: true`
 *     without a key argument is a programming error and throws at registration.
 */

import { log } from "../log.js";
import type { ToolSchema } from "../llm/provider.js";
import type { Assistant, Conversation, Operation, Stored } from "../domain/types.js";
import { CompileError, type CompiledModule } from "./dynamic/compile.js";
import type { OperationHost } from "./dynamic/host.js";
import { dynamicDescribers, type OperationDescriber } from "./describers.js";

export interface OperationContext {
    conversation: Stored<Conversation>;
    assistant: Stored<Assistant>;
    /** Deterministic across a re-run of the same Turn: `<conversationId>:<entrySeq>`. */
    idempotencyKey: string;
}

/** An Operation either answers now, or it cannot answer now and the Conversation must suspend. */
export type OperationOutcome =
    | { kind: "value"; value: unknown }
    | { kind: "error"; message: string }
    | {
          kind: "pending";
          waitingFor: "user" | "tool" | "assistant";
          wakeAt?: string;
          /** Set when the pending operation raised an Open Question. */
          questionId?: string;
          note?: string;
      };

export interface GrantedOperation {
    /** The Operation name as an Assistant declares it, e.g. `bookkeeping.postTransaction`. */
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    /** True when the Operation changes state in some Authority. */
    mutating: boolean;
    /**
     * This Operation refuses to run without an approval for these exact arguments.
     *
     * The check lives on the **Operation**, not on the Assistant's grant: making it per-Assistant
     * configuration would be the same probabilistic arrangement ADR-0010 rejected, moved one level
     * up. An Assistant cannot talk its way past it, because it is never asked.
     *
     * Not for the Manual Connectors. `bank.sendMoney`, `email.send` and `document.requestText`
     * already suspend with an Open Question the User answers by *doing the thing*; an approval there
     * would ask them to approve doing something they are about to be asked to do themselves.
     */
    requiresApproval?: boolean;
    /**
     * How the approval question reads to the User. Falls back to the Operation name and a JSON
     * block — which exists so the check never blocks on a missing renderer, not as an experience.
     */
    describeCall?(args: Record<string, unknown>): string;
    execute(args: Record<string, unknown>, context: OperationContext): Promise<OperationOutcome>;
    /**
     * "Did this call already land, under this key?"
     *
     * This is what makes the intent log worth keeping. When a Turn is recovered after a crash,
     * the Conversation may hold a tool intent with no result: the Operation may have completed,
     * or may never have started, and re-running it could book the same invoice twice.
     *
     * A mutating Operation that cannot answer this question forces the recovery path to escalate to
     * the User rather than guess — which is the safe default, not a bug.
     */
    reconcile?(
        args: Record<string, unknown>,
        context: OperationContext,
    ): Promise<OperationOutcome | undefined>;
}

/**
 * Code. What only code can hold (ADR-0019).
 *
 * The half of an Operation that cannot be data: what it does, whether doing it changes anything,
 * and how to ask whether it already happened. Its `seed` is what the Operation Thing is *created*
 * with — bootstrap re-applies only the mechanical part of it and never a decision the User has
 * since taken.
 */
export interface OperationImplementation {
    /** The Operation key. The natural key on both sides of the join. */
    name: string;
    /** Whether `execute` changes state. Authoritative here, and NOT read from the Thing. */
    mutating: boolean;
    /**
     * May the client execute this directly, with no Conversation behind it? (ADR-0023.)
     *
     * Two obligations come with setting it, and neither can be checked by the compiler:
     *
     *   1. **`mutating` must be `false`.** The inbox refuses otherwise, but the flag is a claim about
     *      safety and setting it on a write is a lie the reader of this file should not have to
     *      catch.
     *   2. **`execute` may not read its `context`.** There is no Conversation, no Assistant and no
     *      idempotency key when the caller is a browser — the Operation was not called from a Turn.
     *      An Operation that needs any of those is not client-readable, however harmless it looks.
     *
     * It is deliberately a property of the *Implementation* rather than of the Operation Thing: the
     * Thing is editable, and this is a safety decision. Same argument as `mutating` above, and the
     * same one `resolve()` makes further down.
     */
    clientReadable?: true;
    execute(args: Record<string, unknown>, context: OperationContext): Promise<OperationOutcome>;
    reconcile?(
        args: Record<string, unknown>,
        context: OperationContext,
    ): Promise<OperationOutcome | undefined>;
    describeCall?(args: Record<string, unknown>): string;
    seed: {
        name: string;
        system: string;
        kind: "internal" | "connector" | "manual-connector";
        description: string;
        parameters: Record<string, unknown>;
        requiresApproval?: boolean;
        /**
         * ADR-0025 fields, carried by a Dynamic Operation's seed. `implementation` is on the mirror
         * side of bootstrap's line — a fact about how the Operation is built. `source`, `language`,
         * `egress`, `timeoutMs` and `clientReadable` are on the decision side: created once from the
         * seed and never re-applied, so a running Operation the User has edited is left alone.
         */
        implementation?: "built-in" | "dynamic";
        source?: string;
        language?: "typescript" | "javascript";
        egress?: string;
        timeoutMs?: number;
        clientReadable?: boolean;
    };
}

/**
 * A grant that resolved to nothing, and why.
 *
 * Returned rather than merely logged: after this change *"X is not one of your tools"* is false for
 * the likeliest case — the User switched the Operation off and the grant is still in the Assistant's
 * definition — and a model told it never had a capability re-plans around a premise that is untrue.
 */
export interface DroppedGrant {
    /** The grant as the Assistant declared it, callee and all. */
    key: string;
    /**
     * `ambiguous` and `uncompilable` are ADR-0025's: a key that resolves to *both* a built-in and a
     * stored Implementation is refused rather than ranked, and a Dynamic Operation whose Source does
     * not compile is a dropped grant with the compiler's message in the log. `unconfigured-egress`
     * is the third the dynamic path needs: a Source may name an egress deployment has not defined.
     */
    reason:
        | "absent"
        | "disabled"
        | "unimplemented"
        | "unparseable"
        | "self-call"
        | "bare-call"
        | "ambiguous"
        | "uncompilable"
        | "unconfigured-egress";
}

export interface Resolution {
    granted: GrantedOperation[];
    dropped: DroppedGrant[];
}

export class OperationRegistry {
    private readonly operations = new Map<string, OperationImplementation>();

    /**
     * Operations already warned about for having a weaker `requiresApproval` than their seed.
     *
     * Held on the registry, of which there is exactly one per process: the catalogue is read once
     * per Turn, so warning per resolution would put a line in the log for every Turn of every
     * Conversation — which is how a warning becomes something people filter out. A restart
     * re-announces it; a busy afternoon does not.
     */
    private readonly warnedWeaker = new Set<string>();

    /**
     * Dynamic Operations already warned about for being `mutating` with no `reconcile`. Same
     * once-per-process discipline as {@link warnedWeaker}, and the same reason: the catalogue is read
     * once per Turn, so warning per resolution would bury the line. `bookkeeping.postTransaction`
     * without a `reconcile` is a double booking waiting for a crash (ADR-0025), so it is said — but once.
     */
    private readonly warnedNoReconcile = new Set<string>();

    /**
     * The Operation Host compiles and runs Dynamic Operations (ADR-0025). Optional so a test that
     * only exercises built-in resolution can construct a bare registry; production always wires it
     * in {@link buildRuntime}. A dynamic Thing met with no Host is dropped as `unimplemented`.
     *
     * `describers` supplies the synchronous approval-prompt renderer for a Dynamic Operation that
     * needs one (the money-moving ones) — see {@link dynamicDescribers}. Defaulted so callers rarely
     * pass it; a test overrides it to check the wiring.
     */
    constructor(
        private readonly host?: OperationHost,
        private readonly describers: Record<string, OperationDescriber> = dynamicDescribers,
    ) {}

    register(implementation: OperationImplementation): void {
        if (this.operations.has(implementation.name)) {
            throw new Error(`Operation ${implementation.name} is already registered`);
        }
        this.operations.set(implementation.name, implementation);
    }

    registerAll(implementations: OperationImplementation[]): void {
        for (const implementation of implementations) this.register(implementation);
    }

    get(name: string): OperationImplementation | undefined {
        return this.operations.get(name);
    }

    /**
     * Every registered Implementation, for bootstrap.
     *
     * Deliberately not a catalogue: the seeds are what an Operation Thing is *created* with, and
     * `advance()` has no path back to them — an empty catalogue throws rather than falling back
     * (ADR-0019).
     */
    all(): OperationImplementation[] {
        return [...this.operations.values()];
    }

    /**
     * The Operations this Assistant declared, resolved against the catalogue and what is implemented.
     *
     * `assistant.call:<key>` is declared per callee — a bare `assistant.call` would let an
     * Assistant reach every Assistant including itself, which would empty ADR-0010's promise
     * that reading an Assistant tells you what it can reach.
     */
    grantedTo(assistant: Assistant, catalogue: Operation[]): Resolution {
        const declared = (assistant.grants ?? [])
            .map((grant) => grant.operationKey?.trim())
            .filter((key): key is string => Boolean(key));

        const granted: GrantedOperation[] = [];
        const dropped: DroppedGrant[] = [];
        /**
         * Collapse duplicates on the **resolved** name — `assistant.call:accountant` for a bound
         * callee, not the bare `assistant.call` two such grants share.
         *
         * The check used to sit in the non-`assistant.call` branch alone, so two grants naming one
         * callee reached the provider as two identically named functions. OpenAI rejects that
         * outright: the Turn fails, rather than the duplicate grant being quietly ignored.
         */
        const push = (operation: GrantedOperation) => {
            if (!granted.some((existing) => existing.name === operation.name)) granted.push(operation);
        };
        const drop = (key: string, reason: DroppedGrant["reason"], detail?: string) => {
            dropped.push({ key, reason });
            log.warn("a granted Operation was dropped", {
                assistant: assistant.key,
                key,
                reason,
                ...(detail ? { detail } : {}),
            });
        };

        for (const key of declared) {
            const base = key.includes(":") ? key.slice(0, key.indexOf(":")) : key;

            const thing = catalogue.find((candidate) => candidate.key === base);
            if (!thing) {
                drop(key, "absent");
                continue;
            }
            // Tri-state: unset reads as enabled, the same reading `Assistant.enabled === false`
            // already gets. A Thing created by hand with the box untouched is not switched off.
            if (thing.enabled === false) {
                drop(key, "disabled");
                continue;
            }
            // The two-source join (ADR-0025). `implementation` unset reads as `built-in`. A key that
            // resolves to *both* a compiled and a stored Implementation is refused as `ambiguous`, in
            // both directions — ranking would let a half-finished migration hide which one moved money.
            const kind: "built-in" | "dynamic" =
                thing.implementation === "dynamic" ? "dynamic" : "built-in";
            const codeImplementation = this.operations.get(base);
            const hasSource = (thing.source ?? "").trim() !== "";

            let module: CompiledModule | undefined;
            if (kind === "built-in") {
                if (!codeImplementation) {
                    drop(key, "unimplemented");
                    continue;
                }
                if (hasSource) {
                    drop(key, "ambiguous", "a built-in Operation must not carry stored source");
                    continue;
                }
            } else {
                if (codeImplementation) {
                    drop(key, "ambiguous", "a dynamic Operation is also registered in code");
                    continue;
                }
                if (!hasSource) {
                    drop(key, "unimplemented");
                    continue;
                }
                if (!this.host) {
                    drop(key, "unimplemented", "no Operation Host is wired to run stored source");
                    continue;
                }
                try {
                    module = this.host.compile(thing.source ?? "", thing.language);
                } catch (error) {
                    drop(
                        key,
                        "uncompilable",
                        error instanceof CompileError || error instanceof Error
                            ? error.message
                            : String(error),
                    );
                    continue;
                }
                // An unset egress is legal — a compute-only Operation. A *named* egress that
                // configuration does not define is not: it is a request to nowhere, dropped by name.
                if (thing.egress && thing.egress !== "" && !this.host.hasEgress(thing.egress)) {
                    drop(key, "unconfigured-egress", `egress "${thing.egress}"`);
                    continue;
                }
            }

            let parameters: Record<string, unknown>;
            try {
                // Parsing is not enough. `null`, `5`, `true` and `"x"` are all valid JSON and none
                // of them is a parameter schema — and `null` is not merely useless: `withCalleeBound`
                // reads `properties` off it, and the TypeError leaves `advance()` altogether. Nothing
                // above it escalates, so the Conversation is retried on every scan forever while the
                // heartbeat stays green, which is precisely the silent death ADR-0015 forbids. Same
                // drop reason as a syntax error, because it is the same fault: this field is
                // read-only in the form, so anything wrong with it came from a hand-edited document
                // or a bad seed.
                const parsed: unknown = JSON.parse(thing.parameters ?? "");
                if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
                    throw new Error(
                        `parameters are ${describeJson(parsed)}, and a parameter schema must be a JSON object`,
                    );
                }
                parameters = parsed as Record<string, unknown>;
            } catch (error) {
                drop(key, "unparseable", error instanceof Error ? error.message : String(error));
                continue;
            }

            const operation =
                kind === "dynamic"
                    ? this.resolveDynamic(base, module!, thing, parameters)
                    : this.resolve(codeImplementation!, thing, parameters);

            if (base === "assistant.call") {
                // A bare `assistant.call` (no `:callee`) is not a wildcard — it is a mistake.
                // Without this guard `slice(indexOf(":") + 1)` returns the whole string and the
                // Assistant is offered `assistant.call:assistant.call`, which throws on every use
                // and burns a Turn against maxTurns.
                if (!key.includes(":")) {
                    drop(key, "bare-call");
                    continue;
                }
                const callee = key.slice(key.indexOf(":") + 1);
                if (!callee || callee === assistant.key) {
                    drop(key, "self-call");
                    continue;
                }
                push(withCalleeBound(operation, callee));
            } else {
                push(operation);
            }
        }
        return { granted, dropped };
    }

    /** Callee keys this Assistant is permitted to call, for validating `assistant.call`. */
    calleesOf(assistant: Assistant): string[] {
        return (assistant.grants ?? [])
            .map((grant) => grant.operationKey ?? "")
            .filter((key) => key.startsWith("assistant.call:"))
            .map((key) => key.slice("assistant.call:".length))
            .filter((callee) => callee && callee !== assistant.key);
    }

    /**
     * Resolve, then take the schemas. Convenient for a caller that wants nothing else — `advance()`
     * is not one of them: it resolves once per Turn and calls {@link toolSchemas} on the result,
     * so the advertised set and the executable set are literally the same list.
     */
    schemasFor(assistant: Assistant, catalogue: Operation[]): ToolSchema[] {
        return toolSchemas(this.grantedTo(assistant, catalogue).granted);
    }

    /**
     * Build the executable for a Dynamic Operation reached through the inbound door (ADR-0023/0025).
     *
     * The gate has already read `clientReadable`, `mutating` and `requiresApproval` off the Thing;
     * this only compiles the Source and hands back something to run. `undefined` when there is no
     * Host, no Source, or the Source does not compile — each a refusal at the door, indistinguishable
     * from the others, so a browser learns nothing.
     */
    clientExecutable(thing: Operation): GrantedOperation | undefined {
        if (!this.host) return undefined;
        if ((thing.source ?? "").trim() === "") return undefined;
        // A named egress that configuration does not define is refused here too, so the inbound door
        // answers a clean refusal rather than running to a 502 — matching what `grantedTo` does for
        // the same Thing.
        if (thing.egress && thing.egress !== "" && !this.host.hasEgress(thing.egress)) return undefined;
        let module: CompiledModule;
        try {
            module = this.host.compile(thing.source ?? "", thing.language);
        } catch {
            return undefined;
        }
        let parameters: Record<string, unknown> = {};
        try {
            const parsed: unknown = JSON.parse(thing.parameters ?? "{}");
            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
                parameters = parsed as Record<string, unknown>;
            }
        } catch {
            // The door does not need a valid parameter schema to run the Operation — that is the
            // Assistants' concern (the LLM never sees this call). An empty object is fine.
        }
        return this.resolveDynamic(thing.key ?? "", module, thing, parameters);
    }

    /** The join itself: prose and approval from the Thing, behaviour from the Implementation. */
    private resolve(
        implementation: OperationImplementation,
        thing: Operation,
        parameters: Record<string, unknown>,
    ): GrantedOperation {
        // The Thing wins in both directions — `requiresApproval` is the User's (ADR-0018, amended).
        // Only an *unset* checkbox falls back to the seed, so a hand-created Operation cannot
        // switch a guard off by omission.
        const requiresApproval = thing.requiresApproval ?? implementation.seed.requiresApproval ?? false;
        if (implementation.seed.requiresApproval && !requiresApproval) {
            if (!this.warnedWeaker.has(implementation.name)) {
                this.warnedWeaker.add(implementation.name);
                log.warn("an Operation no longer requires the approval its code shipped with", {
                    operation: implementation.name,
                });
            }
        }
        return {
            name: implementation.name,
            description: thing.description ?? implementation.seed.description,
            parameters,
            // Never from the Thing: `reconcile()` treats a non-mutating Operation as safe to
            // consider repeated, so a `mutating: false` on a booking would make crash recovery
            // report it as harmless — ADR-0012's failure, supplied by the safety mechanism.
            mutating: implementation.mutating,
            ...(requiresApproval ? { requiresApproval: true } : {}),
            ...(implementation.describeCall ? { describeCall: implementation.describeCall } : {}),
            execute: (args, context) => implementation.execute(args, context),
            ...(implementation.reconcile
                ? {
                      reconcile: (args: Record<string, unknown>, context: OperationContext) =>
                          implementation.reconcile!(args, context),
                  }
                : {}),
        };
    }

    /**
     * The join for a Dynamic Operation: prose, approval, `mutating` and the egress all come from the
     * Thing (there is no compiled author to ask), and `execute`/`reconcile` run the compiled Source
     * through the Operation Host. This is the one place `mutating` is read from the Thing — the trust
     * anchor is the store's write authority, not code review (ADR-0025).
     */
    private resolveDynamic(
        base: string,
        module: CompiledModule,
        thing: Operation,
        parameters: Record<string, unknown>,
    ): GrantedOperation {
        const host = this.host!;
        const mutating = thing.mutating === true;
        const requiresApproval = thing.requiresApproval === true;
        const describe = this.describers[base];
        const target = { key: base, egress: thing.egress, timeoutMs: thing.timeoutMs };
        const declaresReconcile = host.declaresReconcile(module);

        // A mutating Dynamic Operation with no reconcile is a double booking waiting for a crash. Not
        // refused — the recovery path escalates rather than guessing, which is the safe answer — but
        // said, once per process.
        if (mutating && !declaresReconcile && !this.warnedNoReconcile.has(base)) {
            this.warnedNoReconcile.add(base);
            log.warn("a mutating Dynamic Operation declares no reconcile", { operation: base });
        }

        return {
            name: base,
            description: thing.description ?? "",
            parameters,
            mutating,
            ...(requiresApproval ? { requiresApproval: true } : {}),
            ...(describe ? { describeCall: describe } : {}),
            async execute(args, context): Promise<OperationOutcome> {
                const outcome = await host.run(module, "execute", args, context, target);
                return outcome ?? { kind: "error", message: `Operation ${base} produced no outcome` };
            },
            ...(declaresReconcile
                ? {
                      reconcile: (args: Record<string, unknown>, context: OperationContext) =>
                          host.run(module, "reconcile", args, context, target),
                  }
                : {}),
        };
    }
}

/**
 * Where the two vocabularies meet: Granted Operations in, the provider's `tools` array out. Past
 * this point everything is the provider's.
 */
export function toolSchemas(granted: GrantedOperation[]): ToolSchema[] {
    return granted.map((operation) => ({
        name: toolNameForLlm(operation.name),
        description: operation.description,
        parameters: operation.parameters,
    }));
}

/** What the parsed value was, for the drop detail — the reader needs to know which JSON it got. */
function describeJson(value: unknown): string {
    if (value === null) return "null";
    if (Array.isArray(value)) return "an array";
    return `a ${typeof value}`;
}

/**
 * Tool names travel through the LLM API, which in OpenAI's case rejects dots in some SDKs and
 * historically restricted the character set. Underscores are universally safe, so the wire name
 * is the Operation name with dots and colons replaced, and translated back on the way in.
 */
export function toolNameForLlm(operation: string): string {
    return operation.replace(/[.:]/g, "__");
}

export function operationFromLlm(name: string): string {
    return name.replace(/__/g, ".");
}

function withCalleeBound(operation: GrantedOperation, callee: string): GrantedOperation {
    return {
        ...operation,
        name: `${operation.name}:${callee}`,
        description: `${operation.description} Calls the "${callee}" Assistant.`,
        parameters: {
            ...operation.parameters,
            properties: {
                ...((operation.parameters["properties"] as Record<string, unknown>) ?? {}),
                assistantKey: {
                    type: "string",
                    const: callee,
                    description: `Always "${callee}".`,
                },
            },
        },
        async execute(args, context) {
            return operation.execute({ ...args, assistantKey: callee }, context);
        },
        ...(operation.reconcile
            ? {
                  async reconcile(args: Record<string, unknown>, context: OperationContext) {
                      return operation.reconcile!({ ...args, assistantKey: callee }, context);
                  },
              }
            : {}),
    };
}
