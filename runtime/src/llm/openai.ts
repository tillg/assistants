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

/** `usage` has always been on the response; it was read and dropped until item 6. */
interface OpenAiUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
}

/**
 * The markup a Qwen-family model emits when its tool call is not parsed into `tool_calls`.
 *
 * Deliberately narrow: it must not match an Assistant legitimately *discussing* a tool call in
 * prose. `<function=` and `<tool_call>` together with an opening angle bracket are the wire markers
 * the parser itself looks for, so matching them means the gateway saw the same thing and gave up.
 */
const MALFORMED_TOOL_CALL = /<tool_call>|<function=/;

export class OpenAiProvider implements LlmProvider {
    readonly name = "openai";

    /**
     * `temperature` is sent only when configured, so the provider's own default stands unless
     * someone has a reason to override it.
     *
     * The reason that exists today is local, quantized models. Measured against a 4-bit Qwen3
     * served over this same OpenAI-compatible API: at the default temperature it emits its
     * tool-call markup as **plain assistant text** — `<function=thingstore__get>…` — with
     * `finish_reason: "stop"`. The Runtime then reads a perfectly ordinary answer, ends the
     * Conversation `answered`, and records the markup as the Result. Nothing errors, nothing is
     * retried, and the Conversation looks successful having done nothing at all. At temperature 0
     * the same model returns a structured `tool_calls` array.
     */
    constructor(
        private readonly baseUrl: string,
        private readonly apiKey: string,
        private readonly fetchImpl: typeof fetch = fetch,
        private readonly temperature?: number,
    ) {}

    async complete(request: LlmRequest): Promise<LlmResponse> {
        const body = {
            model: request.model,
            ...(this.temperature === undefined ? {} : { temperature: this.temperature }),
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

        const payload = (await response.json()) as { choices?: OpenAiChoice[]; usage?: OpenAiUsage };
        const choice = payload.choices?.[0];
        if (!choice) {
            throw new TransientLlmError("LLM returned no choices");
        }

        const toolCalls: LlmToolCall[] = (choice.message.tool_calls ?? []).map((call) => ({
            id: call.id,
            name: call.function.name,
            arguments: parseArguments(call.function.arguments),
        }));

        const text = choice.message.content ?? "";

        // A tool call the gateway failed to parse arrives as an ordinary answer, and that is the
        // worst shape it could take: `finish_reason: "stop"`, no `tool_calls`, and markup where the
        // prose should be. Measured against a 4-bit local model — it emits
        // `<function=thingstore__get>…</tool_call>` as content, the Turn reads a perfectly good
        // answer, the Conversation ends `answered`, and the markup becomes its Result. Nothing
        // errors and nothing retries: a Conversation that did nothing looks like one that finished.
        //
        // Reported as an error instead, which is a shape the loop already knows how to carry: the
        // model sees it on the next Turn and can call the Operation properly. ADR-0015 is the rule
        // being kept here — nothing ends silently, least of all something that ended by accident.
        if (toolCalls.length === 0 && MALFORMED_TOOL_CALL.test(text)) {
            // Thrown rather than returned, so `callLlmWithRetries` retries it inside the Turn. A
            // malformed emission is exactly the failure a retry fixes — the same prompt at
            // temperature 0 usually parses on the next attempt — and going straight to the User
            // would escalate something the model can correct unaided. `llmMaxAttempts` bounds it,
            // and a model that degrades every time still ends up in front of the User.
            throw new TransientLlmError(
                "The model emitted a tool call as text rather than as a structured call, so nothing " +
                    "was invoked.",
            );
        }

        return {
            text,
            toolCalls,
            finishReason:
                toolCalls.length > 0
                    ? "wants-tools"
                    : choice.finish_reason === "length"
                      ? "length"
                      : "answered",
            // Omitted rather than zeroed when the gateway did not report it: a zero would be a claim
            // that this Turn was free, and an OpenAI-compatible gateway is not obliged to answer.
            ...(payload.usage
                ? {
                      usage: {
                          promptTokens: payload.usage.prompt_tokens ?? 0,
                          completionTokens: payload.usage.completion_tokens ?? 0,
                      },
                  }
                : {}),
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
