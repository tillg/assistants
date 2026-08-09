/**
 * A provider that replays recorded responses.
 *
 * This is not a mock of a collaborator we own — it is a recorded substitute for a paid,
 * non-deterministic third party, and it is the only way the loop's branching (pending tool call
 * → suspend → resume → recover) can be asserted at all. Selecting it through `LLM_PROVIDER`
 * means the end-to-end tier drives the *real* Runtime, ThingStore, Firefly and UI, and only the
 * model is substituted.
 *
 * Scripts match on the assistant key and the turn number, so one file can drive a whole
 * multi-Assistant scenario.
 */

import { readFileSync } from "node:fs";
import { log } from "../log.js";
import type { LlmProvider, LlmRequest, LlmResponse, LlmToolCall } from "./provider.js";

export interface ScriptedStep {
    /** Matches Assistant.key; omit to match any. */
    assistant?: string;
    /** Zero-based turn within that Conversation; omit to match any. */
    turn?: number;
    /** Matches when the last message contains this substring; omit to match any. */
    whenContains?: string;
    text?: string;
    toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
    finishReason?: "answered" | "wants-tools" | "length" | "error";
}

export interface ScriptedContext {
    assistantKey: string;
    turn: number;
}

export class ScriptedProvider implements LlmProvider {
    readonly name = "scripted";
    private callCount = 0;

    constructor(
        private readonly steps: ScriptedStep[],
        private readonly context: () => ScriptedContext,
    ) {}

    static fromFile(file: string, context: () => ScriptedContext): ScriptedProvider {
        let steps: ScriptedStep[] = [];
        try {
            steps = JSON.parse(readFileSync(file, "utf8")) as ScriptedStep[];
            log.info("scripted LLM loaded", { file, steps: steps.length });
        } catch (error) {
            log.warn("no scripted LLM file; every call will answer with a stub", {
                file,
                error: String(error),
            });
        }
        return new ScriptedProvider(steps, context);
    }

    async complete(request: LlmRequest): Promise<LlmResponse> {
        this.callCount += 1;
        const { assistantKey, turn } = this.context();
        const lastContent = request.messages.at(-1)?.content ?? "";

        const step = this.steps.find(
            (candidate) =>
                (candidate.assistant === undefined || candidate.assistant === assistantKey) &&
                (candidate.turn === undefined || candidate.turn === turn) &&
                (candidate.whenContains === undefined || lastContent.includes(candidate.whenContains)),
        );

        if (!step) {
            // NOT `answered`. This is the compose default, so a user who follows the README and
            // drops in a real invoice would otherwise watch the Conversation run off the end of
            // the fixture and report success having done nothing. An error escalates into an Open
            // Question, which is at least honest about it.
            log.warn("scripted LLM has no step for this call", { assistantKey, turn });
            return {
                text: "",
                toolCalls: [],
                finishReason: "error",
                error: {
                    message:
                        `The scripted language model has no step for assistant "${assistantKey}" ` +
                        `turn ${turn}. This stack is running with LLM_PROVIDER=scripted; set ` +
                        `LLM_PROVIDER=openai and LLM_API_KEY to use a real model.`,
                    transient: false,
                },
            };
        }

        const toolCalls: LlmToolCall[] = (step.toolCalls ?? []).map((call, index) => ({
            id: `scripted-${this.callCount}-${index}`,
            name: call.name,
            arguments: call.arguments,
        }));

        return {
            text: step.text ?? "",
            toolCalls,
            finishReason: step.finishReason ?? (toolCalls.length > 0 ? "wants-tools" : "answered"),
        };
    }
}
