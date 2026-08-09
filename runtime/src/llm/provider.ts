/**
 * The LLM behind an interface.
 *
 * The interface exists for one reason above all: the loop's interesting behaviour is its
 * *branching* — suspend on a pending tool call, resume on an answer, recover a lease without
 * re-executing — and none of that can be asserted against a paid, non-deterministic third party.
 * `ScriptedProvider` replays recorded responses so the branches are testable, and it is selected
 * by an environment variable so the end-to-end tier can drive the real stack deterministically.
 */

export interface ToolSchema {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

export interface LlmToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}

export type LlmFinishReason = "answered" | "wants-tools" | "length" | "error";

export interface LlmResponse {
    text: string;
    toolCalls: LlmToolCall[];
    finishReason: LlmFinishReason;
    /** Present when finishReason is "error"; the loop decides whether it is transient. */
    error?: { message: string; transient: boolean };
}

export interface LlmMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    toolCallId?: string;
    toolName?: string;
    toolCalls?: LlmToolCall[];
}

export interface LlmRequest {
    model: string;
    messages: LlmMessage[];
    tools: ToolSchema[];
}

export interface LlmProvider {
    readonly name: string;
    complete(request: LlmRequest): Promise<LlmResponse>;
}

export class TransientLlmError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TransientLlmError";
    }
}

/** 408, 409, 429 and 5xx are worth retrying; everything else is the model's or our problem. */
export function isTransientStatus(status: number): boolean {
    return status === 408 || status === 409 || status === 429 || status >= 500;
}
