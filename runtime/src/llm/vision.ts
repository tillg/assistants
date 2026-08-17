/**
 * A second, deliberately tiny LLM port: read a PDF that has no text layer.
 *
 * This does not go through {@link LlmProvider}, and that is a decision rather than an oversight.
 * `LlmMessage.content` is a `string`, and carrying a PDF would mean widening it to a parts array —
 * which means touching all four implementations, including `scripted`, whose entire value is that
 * it is trivial; making every provider answer a question the agentic loop never asks, since no Turn
 * ever sends a document; and leaving the loop's type surface permanently more complicated for the
 * sake of one Operation. So the loop keeps its one method, and this port has one of its own.
 *
 * The Anthropic implementation sends the PDF as a `document` content block with a base64 source.
 * No beta header, and nothing rasterises anything — which is what keeps poppler, a canvas and
 * Tesseract out of the image.
 */

import {
    isTransientStatus,
    TransientLlmError,
    type LlmUsage,
} from "./provider.js";
import { ConfigurationError, type LlmProfile } from "./profiles.js";

/**
 * The prompt, fixed in code, taking no input whatsoever from the Document — not its filename, not
 * its metadata, not a single byte of its contents beyond the PDF itself.
 *
 * This is a security property, not a style choice. The attachment is untrusted content from outside
 * the system, and a prompt assembled from anything it carries would be a prompt-injection surface
 * pointed straight at a model that is about to write into a field the Receptionist trusts. What
 * comes back is treated as *text to be classified*, never as instructions.
 */
const PROMPT =
    "Transcribe the readable contents of this document as plain markdown. " +
    "Preserve every figure, date and amount exactly as printed, and keep the reading order of the " +
    "pages. Output the transcription only: no commentary, no preamble, no explanation.";

/** Generous enough for a ten-page invoice; the page cap is what actually bounds the request. */
const MAX_TOKENS = 8000;

export interface VisionReadResult {
    text: string;
    usage?: LlmUsage;
}

export interface VisionReader {
    /** False when no `vision` profile is configured, or when one is but its key is missing. */
    readonly available: boolean;
    readonly name: string;
    read(pdf: Buffer, pageCount: number): Promise<VisionReadResult>;
}

/**
 * `requiresKey` is a profile field that {@link LlmProfile} does not carry — `loadLlmProfile` folds
 * it into whether it demands a key and then drops it. Declaring it optional here lets a caller that
 * has read it pass it on, without profiles.ts having to grow an export for this one use.
 */
export interface VisionProfile extends LlmProfile {
    readonly requiresKey?: boolean;
}

/** The shipped default: no `vision` profile, so `document.readScan` reports itself unavailable. */
export const NULL_VISION_READER: VisionReader = {
    available: false,
    name: "none",
    read(): Promise<VisionReadResult> {
        return Promise.reject(
            new Error(
                'No vision model is configured. Add a profile to llm.json and name it under "vision", ' +
                    "with its key in .env, for document.readScan to have anything to send the PDF to.",
            ),
        );
    },
};

interface AnthropicContentBlock {
    type: string;
    text?: string;
}

export class AnthropicVisionReader implements VisionReader {
    readonly available = true;
    readonly name = "anthropic";

    constructor(
        private readonly baseUrl: string,
        private readonly model: string,
        private readonly apiKey: string,
        private readonly fetchImpl: typeof fetch = fetch,
    ) {}

    /**
     * `pageCount` is not sent anywhere: the caps live in the Operation, which has already refused
     * anything too long by the time the bytes get here. It is on the port so that a caller cannot
     * reach the model without having counted the pages first.
     */
    async read(pdf: Buffer, pageCount: number): Promise<VisionReadResult> {
        void pageCount;

        const response = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}/v1/messages`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-api-key": this.apiKey,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
                model: this.model,
                max_tokens: MAX_TOKENS,
                messages: [
                    {
                        role: "user",
                        content: [
                            {
                                type: "document",
                                source: {
                                    type: "base64",
                                    media_type: "application/pdf",
                                    // `base64` never wraps; `base64url` would change the alphabet.
                                    data: pdf.toString("base64"),
                                },
                            },
                            { type: "text", text: PROMPT },
                        ],
                    },
                ],
            }),
        });

        if (!response.ok) {
            const body = await response.text().catch(() => "");
            const message = `Vision HTTP ${response.status}: ${body.slice(0, 400)}`;
            if (isTransientStatus(response.status)) throw new TransientLlmError(message);
            throw new Error(message);
        }

        const payload = (await response.json()) as {
            content?: AnthropicContentBlock[];
            // Anthropic's own names: `input_tokens` / `output_tokens`, not OpenAI's.
            usage?: { input_tokens?: number; output_tokens?: number };
        };

        const text = (payload.content ?? [])
            .filter((block) => block.type === "text")
            .map((block) => block.text ?? "")
            .join("");

        return {
            text,
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

/**
 * The `vision` profile, or the null reader — never a half-configured one.
 *
 * A profile without its key is the same situation as no profile at all from `readScan`'s point of
 * view: there is nothing to send the PDF to. It says so through `available` rather than by throwing
 * during start-up, because the vision profile is optional and the rest of the stack runs without it.
 *
 * A profile naming a provider this port cannot speak is the opposite case, and it throws. Only
 * `anthropic` has a vision implementation: the request built below is Anthropic-shaped down to the
 * `x-api-key` header and the `/v1/messages` path, so pointing `vision` at an `openai` profile and
 * building this reader anyway would POST that body at an endpoint that has never heard of it, fail
 * every `document.readScan`, and — worse — do it under a start-up log line reporting `provider:
 * openai`. Sending whoever debugs it to the wrong provider costs more than the failure does. So it
 * is a `ConfigurationError` at start-up, which is what `loadLlmProfile`'s own doc comment argues
 * for: a half-finished edit across `llm.json` and `.env` is cheap to hear about now and expensive
 * to discover hours later, from the first Assistant that meets a scanned invoice.
 *
 * `scripted` throws with the rest, deliberately. There is no scripted vision reader either, so a
 * `"vision": "scripted"` would land in exactly the same silent-Anthropic-request hole — against a
 * `scripted` profile's empty `baseUrl`, at that. Nothing in the stack configures one today; the day
 * one is wanted, it wants an implementation here rather than an exemption.
 */
export function createVisionReader(
    profile: VisionProfile | undefined,
    apiKey: string | undefined,
): VisionReader {
    if (profile === undefined) return NULL_VISION_READER;

    // Before the key check: a wrong provider is wrong whether or not its key is present, and
    // falling through to the null reader would hide the misconfiguration behind "unavailable".
    if (profile.provider !== "anthropic") {
        throw new ConfigurationError(
            `The LLM profile "${profile.name}" is selected by "vision" in llm.json, but its ` +
                `provider is ${profile.provider}.\n\n` +
                `  supported for vision   anthropic\n\n` +
                `Reading a scan sends the PDF as an Anthropic \`document\` content block, and no ` +
                `other provider has an implementation here. Point "vision" at an anthropic ` +
                `profile, or remove the key altogether — without it there is no vision model, ` +
                `reading a scan is unavailable, and an Assistant that meets a PDF with no text ` +
                `layer asks the User to type it instead.`,
        );
    }

    const key = apiKey ?? profile.apiKey ?? "";
    if (key === "" && profile.requiresKey !== false) return NULL_VISION_READER;

    return new AnthropicVisionReader(profile.baseUrl, profile.model, key);
}
