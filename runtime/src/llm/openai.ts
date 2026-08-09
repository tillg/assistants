/** OpenAI-compatible chat-completions provider. Works against OpenAI and any compatible gateway. */

import {
    isTransientStatus,
    TransientLlmError,
    type LlmProvider,
    type LlmRequest,
    type LlmResponse,
    type LlmToolCall,
} from "./provider.js";

interface OpenAiToolCall {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
}

interface OpenAiChoice {
    message: { content: string | null; tool_calls?: OpenAiToolCall[] };
    finish_reason: string;
}

export class OpenAiProvider implements LlmProvider {
    readonly name = "openai";

    constructor(
        private readonly baseUrl: string,
        private readonly apiKey: string,
        private readonly fetchImpl: typeof fetch = fetch,
    ) {}

    async complete(request: LlmRequest): Promise<LlmResponse> {
        const body = {
            model: request.model,
            messages: request.messages.map((message) => {
                if (message.role === "tool") {
                    return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
                }
                if (message.role === "assistant" && message.toolCalls?.length) {
                    return {
                        role: "assistant",
                        content: message.content || null,
                        tool_calls: message.toolCalls.map((call) => ({
                            id: call.id,
                            type: "function",
                            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                        })),
                    };
                }
                return { role: message.role, content: message.content };
            }),
            ...(request.tools.length > 0
                ? {
                      tools: request.tools.map((tool) => ({
                          type: "function",
                          function: {
                              name: tool.name,
                              description: tool.description,
                              parameters: tool.parameters,
                          },
                      })),
                      tool_choice: "auto",
                  }
                : {}),
        };

        const response = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const text = await response.text().catch(() => "");
            const message = `LLM HTTP ${response.status}: ${text.slice(0, 400)}`;
            if (isTransientStatus(response.status)) throw new TransientLlmError(message);
            return { text: "", toolCalls: [], finishReason: "error", error: { message, transient: false } };
        }

        const payload = (await response.json()) as { choices?: OpenAiChoice[] };
        const choice = payload.choices?.[0];
        if (!choice) {
            throw new TransientLlmError("LLM returned no choices");
        }

        const toolCalls: LlmToolCall[] = (choice.message.tool_calls ?? []).map((call) => ({
            id: call.id,
            name: call.function.name,
            arguments: parseArguments(call.function.arguments),
        }));

        return {
            text: choice.message.content ?? "",
            toolCalls,
            finishReason:
                toolCalls.length > 0
                    ? "wants-tools"
                    : choice.finish_reason === "length"
                      ? "length"
                      : "answered",
        };
    }
}

/**
 * A model that emits malformed JSON is not an exception — it is something the next Turn can fix
 * once it sees the error, so we surface it as an argument the tool layer will reject rather than
 * throwing here.
 */
function parseArguments(raw: string): Record<string, unknown> {
    try {
        const parsed: unknown = JSON.parse(raw || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
        return { __malformed: raw };
    } catch {
        return { __malformed: raw };
    }
}
