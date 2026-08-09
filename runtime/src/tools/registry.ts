/**
 * The Tool registry.
 *
 * Two rules from the ADRs are enforced here rather than hoped for:
 *
 *   - **ADR-0010**: an Assistant may use only the Operations its `tools[]` declares. The registry
 *     filters the schemas offered to the LLM by that list, so an undeclared Operation is not
 *     merely refused — it is invisible. (It is refused as well, because "should be unreachable"
 *     is a claim worth testing.)
 *   - **The idempotency contract**: every Operation is either read-only or idempotent under a
 *     caller-supplied key. No Operation may be both mutating and unkeyed. `mutating: true`
 *     without a key argument is a programming error and throws at registration.
 */

import type { ToolSchema } from "../llm/provider.js";
import type { Assistant, Conversation, Stored } from "../domain/types.js";

export interface ToolContext {
    conversation: Stored<Conversation>;
    assistant: Stored<Assistant>;
    /** Deterministic across a re-run of the same Turn: `<conversationId>:<entrySeq>`. */
    idempotencyKey: string;
}

/** A tool either answers now, or it cannot answer now and the Conversation must suspend. */
export type ToolOutcome =
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

export interface ToolDefinition {
    /** The Operation name as an Assistant declares it, e.g. `bookkeeping.postTransaction`. */
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    /** True when the Operation changes state in some Authority. */
    mutating: boolean;
    execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome>;
}

export class ToolRegistry {
    private readonly tools = new Map<string, ToolDefinition>();

    register(tool: ToolDefinition): void {
        if (this.tools.has(tool.name)) {
            throw new Error(`Tool ${tool.name} is already registered`);
        }
        this.tools.set(tool.name, tool);
    }

    registerAll(tools: ToolDefinition[]): void {
        for (const tool of tools) this.register(tool);
    }

    get(name: string): ToolDefinition | undefined {
        return this.tools.get(name);
    }

    /**
     * The Operations this Assistant declared, resolved against what exists.
     *
     * `assistant.call:<key>` is declared per callee — a bare `assistant.call` would let an
     * Assistant reach every Assistant including itself, which would empty ADR-0010's promise
     * that reading an Assistant tells you what it can reach.
     */
    grantedTo(assistant: Assistant): ToolDefinition[] {
        const declared = (assistant.tools ?? [])
            .map((grant) => grant.operation?.trim())
            .filter((operation): operation is string => Boolean(operation));

        const granted: ToolDefinition[] = [];
        for (const operation of declared) {
            const base = operation.includes(":") ? operation.slice(0, operation.indexOf(":")) : operation;
            const tool = this.tools.get(base);
            if (!tool) continue;
            if (base === "assistant.call") {
                const callee = operation.slice(operation.indexOf(":") + 1);
                if (!callee || callee === assistant.key) continue; // no self-calls
                granted.push(withCalleeBound(tool, callee));
            } else if (!granted.some((existing) => existing.name === tool.name)) {
                granted.push(tool);
            }
        }
        return granted;
    }

    /** Callee keys this Assistant is permitted to call, for validating `assistant.call`. */
    calleesOf(assistant: Assistant): string[] {
        return (assistant.tools ?? [])
            .map((grant) => grant.operation ?? "")
            .filter((operation) => operation.startsWith("assistant.call:"))
            .map((operation) => operation.slice("assistant.call:".length))
            .filter((callee) => callee && callee !== assistant.key);
    }

    schemasFor(assistant: Assistant): ToolSchema[] {
        return this.grantedTo(assistant).map((tool) => ({
            name: toolNameForLlm(tool.name),
            description: tool.description,
            parameters: tool.parameters,
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

function withCalleeBound(tool: ToolDefinition, callee: string): ToolDefinition {
    return {
        ...tool,
        name: `${tool.name}:${callee}`,
        description: `${tool.description} Calls the "${callee}" Assistant.`,
        parameters: {
            ...tool.parameters,
            properties: {
                ...((tool.parameters["properties"] as Record<string, unknown>) ?? {}),
                assistantKey: {
                    type: "string",
                    const: callee,
                    description: `Always "${callee}".`,
                },
            },
        },
        async execute(args, context) {
            return tool.execute({ ...args, assistantKey: callee }, context);
        },
    };
}
