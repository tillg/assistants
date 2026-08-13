/**
 * The Operation registry.
 *
 * Two rules from the ADRs are enforced here rather than hoped for:
 *
 *   - **ADR-0010**: an Assistant may use only the Operations its `grants[]` declares. The registry
 *     filters the schemas offered to the LLM by that list, so an undeclared Operation is not
 *     merely refused — it is invisible. (It is refused as well, because "should be unreachable"
 *     is a claim worth testing.)
 *   - **The idempotency contract**: every Operation is either read-only or idempotent under a
 *     caller-supplied key. No Operation may be both mutating and unkeyed. `mutating: true`
 *     without a key argument is a programming error and throws at registration.
 */

import type { ToolSchema } from "../llm/provider.js";
import type { Assistant, Conversation, Stored } from "../domain/types.js";

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

export class OperationRegistry {
    private readonly operations = new Map<string, GrantedOperation>();

    register(operation: GrantedOperation): void {
        if (this.operations.has(operation.name)) {
            throw new Error(`Operation ${operation.name} is already registered`);
        }
        this.operations.set(operation.name, operation);
    }

    registerAll(operations: GrantedOperation[]): void {
        for (const operation of operations) this.register(operation);
    }

    get(name: string): GrantedOperation | undefined {
        return this.operations.get(name);
    }

    /**
     * The Operations this Assistant declared, resolved against what exists.
     *
     * `assistant.call:<key>` is declared per callee — a bare `assistant.call` would let an
     * Assistant reach every Assistant including itself, which would empty ADR-0010's promise
     * that reading an Assistant tells you what it can reach.
     */
    grantedTo(assistant: Assistant): GrantedOperation[] {
        const declared = (assistant.grants ?? [])
            .map((grant) => grant.operationKey?.trim())
            .filter((key): key is string => Boolean(key));

        const granted: GrantedOperation[] = [];
        for (const key of declared) {
            const base = key.includes(":") ? key.slice(0, key.indexOf(":")) : key;
            const operation = this.operations.get(base);
            if (!operation) continue;
            if (base === "assistant.call") {
                // A bare `assistant.call` (no `:callee`) is not a wildcard — it is a mistake.
                // Without this guard `slice(indexOf(":") + 1)` returns the whole string and the
                // Assistant is offered `assistant.call:assistant.call`, which throws on every use
                // and burns a Turn against maxTurns.
                if (!key.includes(":")) continue;
                const callee = key.slice(key.indexOf(":") + 1);
                if (!callee || callee === assistant.key) continue; // no self-calls
                granted.push(withCalleeBound(operation, callee));
            } else if (!granted.some((existing) => existing.name === operation.name)) {
                granted.push(operation);
            }
        }
        return granted;
    }

    /** Callee keys this Assistant is permitted to call, for validating `assistant.call`. */
    calleesOf(assistant: Assistant): string[] {
        return (assistant.grants ?? [])
            .map((grant) => grant.operationKey ?? "")
            .filter((key) => key.startsWith("assistant.call:"))
            .map((key) => key.slice("assistant.call:".length))
            .filter((callee) => callee && callee !== assistant.key);
    }

    schemasFor(assistant: Assistant): ToolSchema[] {
        return this.grantedTo(assistant).map((operation) => ({
            name: toolNameForLlm(operation.name),
            description: operation.description,
            parameters: operation.parameters,
        }));
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
