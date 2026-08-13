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
    reason: "absent" | "disabled" | "unimplemented" | "unparseable" | "self-call" | "bare-call";
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

    /** Every registered Implementation, for bootstrap and for the seed catalogue. */
    all(): OperationImplementation[] {
        return [...this.operations.values()];
    }

    /**
     * A catalogue built from the registered seeds, as bootstrap would have created it.
     *
     * **A shim for phase E.** The real catalogue is a snapshot of `Operation_DM`, read once per
     * Turn; until `advance()` reads it, this stands in so the join is exercised end to end. Delete
     * it — and its call sites in `LoopDriver` and the test harness — when the read arrives.
     */
    seedCatalogue(): Operation[] {
        return this.all().map((implementation) => ({
            key: implementation.name,
            name: implementation.seed.name,
            system: implementation.seed.system,
            kind: implementation.seed.kind,
            description: implementation.seed.description,
            parameters: JSON.stringify(implementation.seed.parameters),
            mutating: implementation.mutating,
            requiresApproval: implementation.seed.requiresApproval ?? false,
            enabled: true,
        }));
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
            const implementation = this.operations.get(base);
            if (!implementation) {
                drop(key, "unimplemented");
                continue;
            }
            let parameters: Record<string, unknown>;
            try {
                parameters = JSON.parse(thing.parameters ?? "") as Record<string, unknown>;
            } catch (error) {
                drop(key, "unparseable", error instanceof Error ? error.message : String(error));
                continue;
            }

            const operation = this.resolve(implementation, thing, parameters);

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
                granted.push(withCalleeBound(operation, callee));
            } else if (!granted.some((existing) => existing.name === operation.name)) {
                granted.push(operation);
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
     * Where the two vocabularies meet: Granted Operations in, the provider's `tools` array out.
     * Past this point everything is the provider's.
     */
    schemasFor(assistant: Assistant, catalogue: Operation[]): ToolSchema[] {
        return this.grantedTo(assistant, catalogue).granted.map((operation) => ({
            name: toolNameForLlm(operation.name),
            description: operation.description,
            parameters: operation.parameters,
        }));
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
