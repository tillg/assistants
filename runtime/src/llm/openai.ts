/** OpenAI-compatible chat-completions provider. Works against OpenAI and any compatible gateway. */

import { createHash } from "node:crypto";

import {
    isTransientStatus,
    TransientLlmError,
    type LlmProvider,
    type LlmRequest,
    type LlmMessage,
    type LlmResponse,
    type LlmToolCall,
    type ToolSchema,
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
 *
 * A profile whose model does this has a `systemSuffix` to answer it with — see `llm.json.example`,
 * where `local_qwen` carries the sentence that makes a 4-bit Qwen wrap its calls properly. This
 * check is what remains for the times the sentence does not hold.
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
        private readonly maxTokens: number = 4096,
        private readonly systemSuffix?: string,
    ) {}

    async complete(request: LlmRequest): Promise<LlmResponse> {
        const body = {
            model: request.model,
            // Bounded, as the Anthropic provider has always bounded it. Omitting it means the
            // gateway's own default applies, and a local server's default is 32768 — at the ~47
            // tokens/second a quantized model manages, one completion can generate for eleven
            // minutes. The Turn does not fail; it simply does not return, the scan that owns it
            // never finishes, and the Runtime stops stamping its heartbeat and reports unhealthy
            // while working perfectly well. Measured: eight Conversations wedged one scan for over
            // ten minutes. A Turn that needs more than this has lost the thread anyway.
            max_tokens: this.maxTokens,
            ...(this.temperature === undefined ? {} : { temperature: this.temperature }),
            messages: withSystemSuffix(request.messages, this.systemSuffix).map((message) => {
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
        // Before giving up on it: the markup *is* a tool call, and one written in a format we can
        // read. A model that meant to call an Operation and merely failed to get it past the
        // gateway's parser should have its call honoured rather than its Turn spent on a retry.
        if (toolCalls.length === 0 && MALFORMED_TOOL_CALL.test(text)) {
            const recovered = toolCallsFromMarkup(text, request.tools);
            if (recovered.length > 0) {
                return {
                    // Whatever the model wrote *around* the call is kept: its own template invites
                    // reasoning before one, and a transcript that drops it reads as though the
                    // Assistant acted without saying why. Only the markup itself goes.
                    text: withoutMarkup(text),
                    toolCalls: recovered,
                    finishReason: "wants-tools",
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

        // A present-but-abnormal `finish_reason` (content_filter, and anything else that is neither a
        // clean `stop` nor `length`) meant the content was blocked or otherwise did not complete —
        // mapping it to "answered" recorded a Conversation that produced nothing as finished
        // successfully. Escalate it instead. An *absent* reason is left as "answered": some
        // OpenAI-compatible gateways omit it, and treating that as an error would break them.
        const reason = choice.finish_reason;
        const abnormal =
            toolCalls.length === 0 && reason != null && reason !== "" && reason !== "stop" && reason !== "length";

        return {
            text,
            toolCalls,
            finishReason:
                toolCalls.length > 0
                    ? "wants-tools"
                    : reason === "length"
                      ? "length"
                      : abnormal
                        ? "error"
                        : "answered",
            ...(abnormal
                ? {
                      error: {
                          message: `The model stopped with finish_reason "${reason}" and returned no usable completion.`,
                          transient: false,
                      },
                  }
                : {}),
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
 * The profile's `systemSuffix` on the end of the system message the loop already sends — or on one
 * of its own, for a caller that sends none.
 *
 * It goes last because it is the thing the model is meant to remember, and it is one string rather
 * than a whole system prompt per profile because the Assistant's own instruction is the Assistant's
 * business: a profile should be able to say what its *model* needs, without owning what the
 * Receptionist is for.
 */
function withSystemSuffix(messages: LlmMessage[], suffix?: string): LlmMessage[] {
    if (!suffix) return messages;
    const system = messages.findIndex((message) => message.role === "system");
    if (system === -1) return [{ role: "system", content: suffix }, ...messages];
    return messages.map((message, index) =>
        index === system ? { ...message, content: `${message.content}\n\n${suffix}` } : message,
    );
}

/**
 * A whole call, as Qwen writes one: the opening tag, everything up to the matching close.
 *
 * `[\s\S]` rather than `.` because the parameters are on their own lines, and non-greedy so two
 * calls in one message stay two calls.
 */
const MARKUP_CALL = /<function=([A-Za-z0-9_.-]+)>([\s\S]*?)<\/function>/g;

const MARKUP_PARAMETER = /<parameter=([A-Za-z0-9_.-]+)>([\s\S]*?)<\/parameter>/g;

/**
 * The other dialect the same family emits: `<tool_call>{"name":…,"arguments":{…}}</tool_call>`. The
 * `MALFORMED_TOOL_CALL` detector admits it (via its `<tool_call>` alternative), so without a reader
 * for it a detectable-but-unrecoverable response burned every retry and then escalated a call whose
 * JSON was trivially parseable.
 */
const MARKUP_JSON_CALL = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

/**
 * The tool calls hidden in markup the gateway did not parse.
 *
 * Deliberately **not** gated on the model's name. What is being read here is a shape, not a
 * vendor: a name that is one of the tools *this very request offered*, wrapped in the exact tags
 * the format uses. A model that never writes those tags never reaches this code, and one that
 * writes them while merely discussing a tool — the case the ordinary `MALFORMED_TOOL_CALL` check
 * has always had to survive — names nothing that was offered and so recovers nothing. A name
 * check, by contrast, would read `model` strings that are free-form by design (`gpt-4o` on an
 * Azure deployment called something else entirely, a gateway serving Qwen under `default`) and
 * would fail exactly where it was needed.
 *
 * Returns an empty array when nothing safely readable is there, which leaves the caller to report
 * the emission as the error it has always been.
 */
function toolCallsFromMarkup(text: string, tools: ToolSchema[]): LlmToolCall[] {
    const offered = new Map(tools.map((tool) => [tool.name, tool]));
    const calls: LlmToolCall[] = [];

    for (const [, name, body] of text.matchAll(MARKUP_CALL)) {
        const tool = offered.get(name!);
        if (!tool) continue;

        const args: Record<string, unknown> = {};
        for (const [, key, raw] of body!.matchAll(MARKUP_PARAMETER)) {
            args[key!] = coerce(raw!.trim(), declaredType(tool, key!));
        }
        // Distinguishable in a transcript from an id the gateway issued, because the difference
        // matters when reading back a Conversation that only worked because of this.
        calls.push({ id: `markup_${calls.length}_${createHash("sha1").update(`${name}${body}`).digest("hex").slice(0, 8)}`, name: name!, arguments: args });
    }

    // The JSON-in-tag dialect. Only a body that parses to an object naming a tool this request
    // offered is read — the same shape-not-vendor guard as above. A `<tool_call>` wrapping a
    // `<function=…>` (which MARKUP_CALL already read) does not parse as JSON, so it is skipped here
    // rather than double-counted.
    for (const [, body] of text.matchAll(MARKUP_JSON_CALL)) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(body!.trim());
        } catch {
            continue;
        }
        if (!parsed || typeof parsed !== "object") continue;
        const name = (parsed as { name?: unknown }).name;
        if (typeof name !== "string" || !offered.has(name)) continue;
        const rawArgs = (parsed as { arguments?: unknown }).arguments;
        const args = rawArgs && typeof rawArgs === "object" ? (rawArgs as Record<string, unknown>) : {};
        calls.push({
            id: `markup_${calls.length}_${createHash("sha1").update(body!).digest("hex").slice(0, 8)}`,
            name,
            arguments: args,
        });
    }

    return calls;
}

/** The prose a recovered call was written among, with the call itself and its wrapper taken out. */
function withoutMarkup(text: string): string {
    return text
        .replace(MARKUP_CALL, "")
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
        .replace(/<\/?tool_call>/g, "")
        .trim();
}

/** What the tool's schema says this parameter is, if it says anything. */
function declaredType(tool: ToolSchema, parameter: string): string {
    const properties = (tool.parameters as { properties?: Record<string, { type?: unknown }> }).properties;
    const declared = properties?.[parameter]?.type;
    return typeof declared === "string" ? declared : "string";
}

/**
 * Markup carries every value as text, so a number arrives as `"120.50"` and an Operation expecting
 * a number is handed a string. The schema says what it should have been, which is the same thing
 * the model's own reference parser reads — anything unreadable is left as the text it was, for the
 * tool layer to reject in its own words.
 */
function coerce(value: string, type: string): unknown {
    if (type === "number" || type === "integer") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : value;
    }
    if (type === "boolean") {
        if (value === "true") return true;
        if (value === "false") return false;
        return value;
    }
    if (type === "object" || type === "array") {
        try {
            return JSON.parse(value);
        } catch {
            return value;
        }
    }
    return value;
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
