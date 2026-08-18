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
    tools: [
        {
            name: "thingstore__get",
            description: "read a Thing",
            parameters: {
                type: "object",
                properties: { model: { type: "string" }, page: { type: "number" } },
            },
        },
    ],
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

    it("bounds the completion, as the Anthropic provider always has", async () => {
        // Without this the gateway's default applies. A local server defaults to 32768, which at a
        // quantized model's speed is minutes of generation inside one Turn — long enough to wedge
        // the scan that owns it and stop the Runtime's heartbeat.
        let sent: Record<string, unknown> = {};
        const provider = new OpenAiProvider("http://gateway/v1", "key", gateway(
            { message: { content: "fine" }, finish_reason: "stop" },
            (body) => (sent = body),
        ));

        await provider.complete(REQUEST);

        expect(sent["max_tokens"]).toBe(4096);
    });

    it("reads a tool call the gateway left as markup as the call it is", async () => {
        // The exact shape a 4-bit Qwen3 produces: HTTP 200, `stop`, no `tool_calls`, and the call
        // written out in the format its own template describes — because it dropped the
        // `<tool_call>` wrapper the server's parser keys on. The call was meant; only the envelope
        // was missing.
        const provider = new OpenAiProvider(
            "http://gateway/v1",
            "key",
            gateway({
                message: {
                    content:
                        "<function=thingstore__get>\n<parameter=model>\nDocument_DM\n</parameter>\n" +
                        "<parameter=page>\n2\n</parameter>\n</function>",
                },
                finish_reason: "stop",
            }),
        );

        const response = await provider.complete(REQUEST);

        expect(response.finishReason).toBe("wants-tools");
        expect(response.toolCalls).toHaveLength(1);
        expect(response.toolCalls[0]!.name).toBe("thingstore__get");
        // Markup carries every value as text; the schema says `page` is a number.
        expect(response.toolCalls[0]!.arguments).toEqual({ model: "Document_DM", page: 2 });
        // The markup itself is not also handed back as prose — it was a call, not an answer.
        expect(response.text).toBe("");
    });

    it("keeps the reasoning a recovered call was written among", async () => {
        // The model's own template invites prose before a call. A transcript that drops it reads as
        // though the Assistant acted without saying why.
        const provider = new OpenAiProvider(
            "http://gateway/v1",
            "key",
            gateway({
                message: {
                    content:
                        "Let me look that up first.\n<tool_call>\n<function=thingstore__get>\n" +
                        "<parameter=model>\nDocument_DM\n</parameter>\n</function>\n</tool_call>",
                },
                finish_reason: "stop",
            }),
        );

        const response = await provider.complete(REQUEST);

        expect(response.toolCalls).toHaveLength(1);
        expect(response.text).toBe("Let me look that up first.");
    });

    it("reads two calls in one message as two calls", async () => {
        const provider = new OpenAiProvider(
            "http://gateway/v1",
            "key",
            gateway({
                message: {
                    content:
                        "<function=thingstore__get>\n<parameter=model>\nA\n</parameter>\n</function>\n" +
                        "<function=thingstore__get>\n<parameter=model>\nB\n</parameter>\n</function>",
                },
                finish_reason: "stop",
            }),
        );

        const response = await provider.complete(REQUEST);

        expect(response.toolCalls.map((call) => call.arguments["model"])).toEqual(["A", "B"]);
    });

    it("refuses to read markup naming a tool the request never offered", async () => {
        // The guard that makes reading markup safe at all: a shape, not a vendor. An Assistant
        // discussing a call it did not make names nothing that was offered, so nothing is invoked
        // — and it stays the error it has always been rather than becoming an answer.
        const provider = new OpenAiProvider(
            "http://gateway/v1",
            "key",
            gateway({
                message: { content: "You would write <function=some__other> to do that." },
                finish_reason: "stop",
            }),
        );

        // Transient, so the Turn retries it rather than escalating something the model can fix.
        await expect(provider.complete(REQUEST)).rejects.toThrow(/as text rather than as a structured call/);
        await expect(provider.complete(REQUEST)).rejects.toBeInstanceOf(TransientLlmError);
    });

    it("appends the profile's systemSuffix to the system message the loop sends", async () => {
        // Measured: `Qwen3-Coder-30B-A3B-Instruct-4bit` drops the `<tool_call>` wrapper its own
        // template requires and its calls arrive as text — three prompts out of three. With this
        // sentence on the system message, three structured calls. It is the profile's because it is
        // true of that model and of no hosted one.
        let sent: Record<string, unknown> = {};
        const provider = new OpenAiProvider(
            "http://gateway/v1",
            "key",
            gateway({ message: { content: "fine" }, finish_reason: "stop" }, (body) => (sent = body)),
            0,
            undefined,
            "Wrap every call in <tool_call> tags.",
        );

        await provider.complete({
            ...REQUEST,
            messages: [{ role: "system", content: "You are the Receptionist." }, ...REQUEST.messages],
        });

        const messages = sent["messages"] as { role: string; content: string }[];
        expect(messages[0]).toEqual({
            role: "system",
            content: "You are the Receptionist.\n\nWrap every call in <tool_call> tags.",
        });
    });

    it("carries the systemSuffix on a system message of its own when the caller sends none", async () => {
        let sent: Record<string, unknown> = {};
        const provider = new OpenAiProvider(
            "http://gateway/v1",
            "key",
            gateway({ message: { content: "fine" }, finish_reason: "stop" }, (body) => (sent = body)),
            0,
            undefined,
            "Wrap every call in <tool_call> tags.",
        );

        await provider.complete(REQUEST);

        const messages = sent["messages"] as { role: string; content: string }[];
        expect(messages[0]).toEqual({ role: "system", content: "Wrap every call in <tool_call> tags." });
        expect(messages).toHaveLength(2);
    });

    it("says nothing extra when the profile sets no systemSuffix", async () => {
        // The sentence names a markup format. A profile that has not asked for it — every hosted
        // one — must not have its model told to write XML tags it otherwise never writes.
        let sent: Record<string, unknown> = {};
        const provider = new OpenAiProvider("http://gateway/v1", "key", gateway(
            { message: { content: "fine" }, finish_reason: "stop" },
            (body) => (sent = body),
        ));

        await provider.complete(REQUEST);

        expect(sent["messages"]).toEqual([{ role: "user", content: "do the thing" }]);
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
