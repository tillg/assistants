/** Anthropic Messages API provider. */

import {
    isTransientStatus,
    TransientLlmError,
    type LlmProvider,
    type LlmRequest,
    type LlmResponse,
    type LlmToolCall,
} from "./provider.js";

interface AnthropicContentBlock {
    type: "text" | "tool_use";
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
}

export class AnthropicProvider implements LlmProvider {
    readonly name = "anthropic";

    constructor(
        private readonly baseUrl: string,
        private readonly apiKey: string,
        private readonly fetchImpl: typeof fetch = fetch,
    ) {}

    async complete(request: LlmRequest): Promise<LlmResponse> {
        const system = request.messages
            .filter((message) => message.role === "system")
            .map((message) => message.content)
            .join("\n\n");

        const messages = request.messages
            .filter((message) => message.role !== "system")
            .map((message) => {
                if (message.role === "tool") {
                    return {
                        role: "user" as const,
                        content: [
                            {
                                type: "tool_result",
                                tool_use_id: message.toolCallId,
                                content: message.content,
                            },
                        ],
                    };
                }
                if (message.role === "assistant" && message.toolCalls?.length) {
                    return {
                        role: "assistant" as const,
                        content: [
                            ...(message.content ? [{ type: "text", text: message.content }] : []),
                            ...message.toolCalls.map((call) => ({
                                type: "tool_use",
                                id: call.id,
                                name: call.name,
                                input: call.arguments,
                            })),
                        ],
                    };
                }
                return { role: message.role as "user" | "assistant", content: message.content };
            });

        const response = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}/v1/messages`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": this.apiKey,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
                model: request.model,
                max_tokens: 4096,
                ...(system ? { system } : {}),
                messages,
                ...(request.tools.length > 0
                    ? {
                          tools: request.tools.map((tool) => ({
                              name: tool.name,
                              description: tool.description,
                              input_schema: tool.parameters,
                          })),
                      }
                    : {}),
            }),
        });

        if (!response.ok) {
            const text = await response.text().catch(() => "");
            const message = `LLM HTTP ${response.status}: ${text.slice(0, 400)}`;
            if (isTransientStatus(response.status)) throw new TransientLlmError(message);
            return { text: "", toolCalls: [], finishReason: "error", error: { message, transient: false } };
        }

        const payload = (await response.json()) as {
            content?: AnthropicContentBlock[];
            stop_reason?: string;
            // Anthropic's own names: `input_tokens` / `output_tokens`, not OpenAI's.
            usage?: { input_tokens?: number; output_tokens?: number };
        };

        const blocks = payload.content ?? [];
        const text = blocks
            .filter((block) => block.type === "text")
            .map((block) => block.text ?? "")
            .join("");
        const toolCalls: LlmToolCall[] = blocks
            .filter((block) => block.type === "tool_use")
            .map((block) => ({
                id: block.id ?? "",
                name: block.name ?? "",
                arguments: block.input ?? {},
            }));

        return {
            text,
            toolCalls,
            finishReason:
                toolCalls.length > 0
                    ? "wants-tools"
                    : payload.stop_reason === "max_tokens"
                      ? "length"
                      : "answered",
            ...(payload.usage
                ? {
                      usage: {
                          promptTokens: payload.usage.input_tokens ?? 0,
                          completionTokens: payload.usage.output_tokens ?? 0,
                      },
                  }
                : {}),
        };
    }
}
