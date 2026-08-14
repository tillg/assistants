/**
 * The OpenAI-compatible provider, at the one seam where a well-formed HTTP 200 can still be a
 * failure: a tool call the gateway did not parse.
 *
 * Every case here was measured against a local 4-bit Qwen3 served over this API, not imagined.
 */

import { describe, expect, it } from "vitest";

import { OpenAiProvider } from "../src/llm/openai.js";
import { TransientLlmError } from "../src/llm/provider.js";
import type { LlmRequest } from "../src/llm/provider.js";

const REQUEST: LlmRequest = {
    model: "some-model",
    messages: [{ role: "user", content: "do the thing" }],
    tools: [{ name: "thingstore__get", description: "read a Thing", parameters: { type: "object" } }],
};

/** A gateway that answers once, with whatever the case needs. */
function gateway(choice: unknown, capture?: (body: Record<string, unknown>) => void): typeof fetch {
    return (async (_url: string, init: { body: string }) => {
        capture?.(JSON.parse(init.body) as Record<string, unknown>);
        return {
            ok: true,
            json: async () => ({ choices: [choice] }),
        };
    }) as unknown as typeof fetch;
}

describe("the OpenAI-compatible provider", () => {
    it("sends no temperature unless one is configured, so the provider's default stands", async () => {
        let sent: Record<string, unknown> = {};
        const provider = new OpenAiProvider("http://gateway/v1", "key", gateway(
            { message: { content: "fine" }, finish_reason: "stop" },
            (body) => (sent = body),
        ));

        await provider.complete(REQUEST);

        expect("temperature" in sent).toBe(false);
    });

    it("sends temperature 0 when configured, which is what a quantized model needs", async () => {
        let sent: Record<string, unknown> = {};
        const provider = new OpenAiProvider(
            "http://gateway/v1",
            "key",
            gateway({ message: { content: "fine" }, finish_reason: "stop" }, (body) => (sent = body)),
            0,
        );

        await provider.complete(REQUEST);

        expect(sent["temperature"]).toBe(0);
    });

    it("refuses to read a tool call emitted as text as though it were an answer", async () => {
        // The exact shape a 4-bit Qwen3 produced: HTTP 200, `stop`, no `tool_calls`, markup as
        // content. Read as an answer it ends the Conversation `answered` having done nothing.
        const provider = new OpenAiProvider(
            "http://gateway/v1",
            "key",
            gateway({
                message: {
                    content:
                        "Let me get the details. <function=thingstore__get> <parameter=model> " +
                        "Document_DM </parameter> </function> </tool_call>",
                },
                finish_reason: "stop",
            }),
        );

        // Transient, so the Turn retries it rather than escalating something the model can fix.
        await expect(provider.complete(REQUEST)).rejects.toThrow(/as text rather than as a structured call/);
        await expect(provider.complete(REQUEST)).rejects.toBeInstanceOf(TransientLlmError);
    });

    it("still reads an ordinary answer as an answer", async () => {
        const provider = new OpenAiProvider(
            "http://gateway/v1",
            "key",
            gateway({ message: { content: "I have booked it." }, finish_reason: "stop" }),
        );

        const response = await provider.complete(REQUEST);

        expect(response.finishReason).toBe("answered");
        expect(response.text).toBe("I have booked it.");
    });

    it("does not mistake a real tool call carrying prose for a malformed one", async () => {
        // `tool_calls` is present, so the gateway parsed it. Content that merely *mentions* the
        // markup must not turn a working call into an error.
        const provider = new OpenAiProvider(
            "http://gateway/v1",
            "key",
            gateway({
                message: {
                    content: "Calling <function=thingstore__get> now.",
                    tool_calls: [
                        { id: "1", type: "function", function: { name: "thingstore__get", arguments: "{}" } },
                    ],
                },
                finish_reason: "tool_calls",
            }),
        );

        const response = await provider.complete(REQUEST);

        expect(response.finishReason).toBe("wants-tools");
        expect(response.toolCalls).toHaveLength(1);
    });
});
