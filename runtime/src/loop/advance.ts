/**
 * The loop driver: `advance(conversation)` takes one Conversation one Turn forward and returns.
 *
 * It holds no state of its own. Everything it needs it reads from the Conversation; everything it
 * learns it writes back before returning. Restarting the process mid-flight is therefore a
 * non-event — which is ADR-0004, and which the agentic-loop survey found all three surveyed
 * systems arrive at independently.
 *
 * Two properties are load-bearing and easy to erode:
 *
 *   1. **One call, one Turn.** This function never loops internally. Continuing a Conversation is
 *      re-entry through the same door birth uses (ADR-0005).
 *   2. **The intent is written before the Operation executes.** If the process dies after Firefly
 *      returns 200 but before we write, recovery must be able to *ask* whether the work landed
 *      rather than doing it again. A result log cannot answer that question; an intent log can.
 */

import { log, describeError } from "../log.js";
import { nowIso, parseIso, SPECS, ThingRepository } from "../a12/things.js";
import type {
    Assistant,
    Conversation,
    Entry,
    FinishReason,
    OpenQuestion,
    Stored,
} from "../domain/types.js";
import { TransientLlmError, type LlmMessage, type LlmProvider } from "../llm/provider.js";
import {
    operationFromLlm,
    ToolRegistry,
    toolNameForLlm,
    type ToolContext,
    type ToolOutcome,
} from "../tools/registry.js";

export interface AdvanceDeps {
    things: ThingRepository;
    registry: ToolRegistry;
    llm: LlmProvider;
    /** Set by the caller so ScriptedProvider can match on the current Assistant and turn. */
    setLlmContext(context: { assistantKey: string; turn: number }): void;
    leaseSeconds: number;
    maxEscalations: number;
    llmMaxAttempts: number;
    /** Raise an Open Question — used by the terminal failure tier. */
    raiseQuestion(input: {
        conversation: Stored<Conversation>;
        assistant: Stored<Assistant>;
        kind: "free-text" | "confirm" | "choice" | "perform";
        prompt: string;
        idempotencyKey: string;
    }): Promise<string>;
}

export interface AdvanceResult {
    status: Conversation["status"];
    turnsRun: number;
    note?: string;
}

const CONVERSATION = SPECS.Conversation_DM;

export function nextSeq(conversation: Conversation): number {
    const entries = conversation.entries ?? [];
    return entries.reduce((max, entry) => Math.max(max, entry.seq ?? 0), 0) + 1;
}

export function appendEntry(conversation: Conversation, entry: Omit<Entry, "seq" | "at">): Entry {
    const full: Entry = { seq: nextSeq(conversation), at: nowIso(), ...entry };
    conversation.entries = [...(conversation.entries ?? []), full];
    return full;
}

/** The context sent to the LLM, rebuilt from the stored Conversation on every Turn. */
export function buildMessages(assistant: Assistant, conversation: Conversation): LlmMessage[] {
    const skills = (assistant.skills ?? []).filter((skill) => skill.instructions?.trim());
    const system = [
        assistant.systemPrompt?.trim() ?? "",
        ...skills.map((skill) => `\n## Skill: ${skill.name ?? "unnamed"}\n\n${skill.instructions}`),
    ]
        .filter(Boolean)
        .join("\n");

    const messages: LlmMessage[] = [{ role: "system", content: system }];

    for (const entry of conversation.entries ?? []) {
        switch (entry.kind) {
            case "prompt":
                messages.push({ role: "user", content: entry.text ?? "" });
                break;
            case "assistant":
                messages.push({ role: "assistant", content: entry.text ?? "" });
                break;
            case "tool-intent":
                messages.push({
                    role: "assistant",
                    content: entry.text ?? "",
                    toolCalls: [
                        {
                            id: entry.idempotencyKey ?? String(entry.seq ?? 0),
                            name: toolNameForLlm(entry.toolName ?? ""),
                            arguments: safeParse(entry.toolArgs),
                        },
                    ],
                });
                break;
            case "tool-result":
                messages.push({
                    role: "tool",
                    content: entry.toolResult ?? "",
                    toolCallId: entry.idempotencyKey ?? String(entry.seq ?? 0),
                    toolName: entry.toolName ?? "",
                });
                break;
            case "answer":
            case "timeout":
            case "note":
            case "error":
                messages.push({ role: "user", content: entry.text ?? "" });
                break;
            default:
                if (entry.text) messages.push({ role: "user", content: entry.text });
        }
    }
    return messages;
}

function safeParse(raw: string | undefined): Record<string, unknown> {
    if (!raw) return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

export class LoopDriver {
    constructor(private readonly deps: AdvanceDeps) {}

    /**
     * Claim the Conversation for this Turn.
     *
     * This is **crash recovery, not mutual exclusion**: A12 has no compare-and-swap, so two
     * Runtimes reading an expired lease would both proceed. Compose therefore runs exactly one
     * replica, and this lease exists so that a Runtime which died mid-Turn does not strand the
     * Conversation forever.
     */
    private claimLease(conversation: Conversation): boolean {
        const lease = parseIso(conversation.leaseUntil);
        if (lease !== undefined && lease > Date.now()) return false;
        conversation.leaseUntil = nowIso(new Date(Date.now() + this.deps.leaseSeconds * 1000));
        return true;
    }

    async advance(docRef: string): Promise<AdvanceResult> {
        const stored = await this.deps.things.get<Conversation>(CONVERSATION, docRef);
        const conversation = stored.data;

        if (conversation.status === "done" || conversation.status === "failed") {
            return { status: conversation.status, turnsRun: 0, note: "already finished" };
        }
        if (!this.claimLease(conversation)) {
            return { status: conversation.status ?? "running", turnsRun: 0, note: "leased elsewhere" };
        }

        const assistant = await this.loadAssistant(conversation.assistantKey ?? "");
        if (!assistant) {
            conversation.status = "failed";
            conversation.finishReason = "error";
            conversation.lastError = `No Assistant with key "${conversation.assistantKey}".`;
            await this.write(stored);
            return { status: "failed", turnsRun: 0, note: "unknown assistant" };
        }
        if (assistant.data.enabled === false) {
            // enabled=false stops continuations as well as births.
            conversation.leaseUntil = "";
            await this.write(stored);
            return { status: conversation.status ?? "waiting", turnsRun: 0, note: "assistant disabled" };
        }

        const maxTurns = conversation.maxTurns ?? assistant.data.maxTurns ?? 20;
        if ((conversation.turnCount ?? 0) >= maxTurns) {
            await this.escalate(
                stored,
                assistant,
                "limit",
                `This conversation reached its limit of ${maxTurns} turns without finishing.`,
            );
            return { status: conversation.status ?? "waiting", turnsRun: 0, note: "max turns" };
        }

        conversation.status = "running";
        conversation.waitingFor = "";

        // --- one Turn ---------------------------------------------------------------------
        this.deps.setLlmContext({
            assistantKey: assistant.data.key ?? "",
            turn: conversation.turnCount ?? 0,
        });

        let response;
        try {
            response = await this.callLlmWithRetries(assistant.data, conversation);
        } catch (error) {
            await this.escalate(
                stored,
                assistant,
                "error",
                `The language model could not be reached: ${describeError(error)}`,
            );
            return { status: conversation.status ?? "waiting", turnsRun: 0, note: "llm unreachable" };
        }

        conversation.turnCount = (conversation.turnCount ?? 0) + 1;

        if (response.finishReason === "error") {
            await this.escalate(
                stored,
                assistant,
                "error",
                `The language model returned an error: ${response.error?.message ?? "unknown"}`,
            );
            return { status: conversation.status ?? "waiting", turnsRun: 1, note: "llm error" };
        }

        if (response.finishReason !== "wants-tools") {
            appendEntry(conversation, { role: "assistant", kind: "assistant", text: response.text });
            conversation.status = "done";
            conversation.finishReason = response.finishReason as FinishReason;
            conversation.result = response.text;
            conversation.leaseUntil = "";
            await this.write(stored);
            log.info("conversation finished", {
                conversationId: stored.thingId,
                assistant: assistant.data.key,
                turns: conversation.turnCount,
            });
            return { status: "done", turnsRun: 1 };
        }

        // --- tool calls -------------------------------------------------------------------
        const granted = this.deps.registry.grantedTo(assistant.data);

        for (const call of response.toolCalls) {
            const operation = operationFromLlm(call.name);
            const tool =
                granted.find((candidate) => toolNameForLlm(candidate.name) === call.name) ??
                granted.find((candidate) => candidate.name === operation);

            const seq = nextSeq(conversation);
            const idempotencyKey = `${stored.thingId}:${seq}`;

            // The intent is written BEFORE the operation runs, so recovery can ask what landed.
            appendEntry(conversation, {
                role: "assistant",
                kind: "tool-intent",
                text: response.text,
                toolName: operation,
                toolArgs: JSON.stringify(call.arguments),
                idempotencyKey,
            });
            await this.write(stored);

            if (!tool) {
                // Undeclared Operations should be unreachable — the registry never offers them —
                // so this is a belt, and there is a test for it.
                appendEntry(conversation, {
                    role: "tool",
                    kind: "tool-result",
                    toolName: operation,
                    toolResult: `Error: "${operation}" is not one of your tools. Available: ${granted
                        .map((candidate) => candidate.name)
                        .join(", ")}`,
                    idempotencyKey,
                });
                continue;
            }

            const context: ToolContext = { conversation: stored, assistant, idempotencyKey };
            let outcome: ToolOutcome;
            try {
                outcome = await tool.execute(call.arguments, context);
            } catch (error) {
                // Recoverable by the model: it sees the error as a tool result and self-corrects.
                outcome = { kind: "error", message: describeError(error) };
            }

            if (outcome.kind === "pending") {
                conversation.status = "waiting";
                conversation.waitingFor = outcome.waitingFor;
                conversation.wakeAt = outcome.wakeAt ?? "";
                conversation.currentQuestionId = outcome.questionId ?? "";
                conversation.leaseUntil = "";
                await this.write(stored);
                log.info("conversation suspended", {
                    conversationId: stored.thingId,
                    waitingFor: outcome.waitingFor,
                    tool: operation,
                });
                return { status: "waiting", turnsRun: 1, note: `pending ${operation}` };
            }

            appendEntry(conversation, {
                role: "tool",
                kind: "tool-result",
                toolName: operation,
                toolResult:
                    outcome.kind === "error"
                        ? `Error: ${outcome.message}`
                        : JSON.stringify(outcome.value ?? null),
                idempotencyKey,
            });
        }

        conversation.leaseUntil = "";
        conversation.status = "running";
        await this.write(stored);
        return { status: "running", turnsRun: 1 };
    }

    /**
     * Transient failures are retried inside the Turn with bounded backoff; each attempt is
     * recorded so the transcript explains itself later.
     */
    private async callLlmWithRetries(assistant: Assistant, conversation: Conversation) {
        const messages = buildMessages(assistant, conversation);
        const tools = this.deps.registry.schemasFor(assistant);
        const model = assistant.llmModel || "gpt-4o-mini";

        let lastError: unknown;
        for (let attempt = 1; attempt <= this.deps.llmMaxAttempts; attempt += 1) {
            try {
                return await this.deps.llm.complete({ model, messages, tools });
            } catch (error) {
                lastError = error;
                if (!(error instanceof TransientLlmError)) throw error;
                appendEntry(conversation, {
                    role: "system",
                    kind: "error",
                    text: `Transient model error on attempt ${attempt}: ${describeError(error)}`,
                });
                if (attempt < this.deps.llmMaxAttempts) {
                    await sleep(250 * 2 ** (attempt - 1));
                }
            }
        }
        throw lastError;
    }

    /**
     * The terminal tier. Nothing may end silently: a stuck Conversation becomes an Open Question,
     * so it surfaces in the same view as everything else and the User can answer, abandon or fix.
     * `failed` therefore comes to mean only "the User abandoned it".
     */
    private async escalate(
        stored: Stored<Conversation>,
        assistant: Stored<Assistant>,
        reason: FinishReason,
        message: string,
    ): Promise<void> {
        const conversation = stored.data;
        conversation.lastError = message;
        conversation.finishReason = reason;

        const escalations = (conversation.escalationCount ?? 0) + 1;
        conversation.escalationCount = escalations;

        appendEntry(conversation, { role: "system", kind: "error", text: message });

        if (escalations > this.deps.maxEscalations) {
            conversation.status = "failed";
            conversation.leaseUntil = "";
            await this.write(stored);
            log.error("conversation failed after repeated escalation", {
                conversationId: stored.thingId,
                escalations,
            });
            return;
        }

        const idempotencyKey = `${stored.thingId}:escalation:${escalations}`;
        const questionId = await this.deps.raiseQuestion({
            conversation: stored,
            assistant,
            kind: "perform",
            prompt: [
                `**This conversation is stuck and needs you.**`,
                ``,
                message,
                ``,
                `Answer to tell it what to do next, or leave it — nothing else will happen until you do.`,
            ].join("\n"),
            idempotencyKey,
        });

        conversation.status = "waiting";
        conversation.waitingFor = "user";
        conversation.currentQuestionId = questionId;
        conversation.leaseUntil = "";
        await this.write(stored);
        log.warn("conversation escalated to the User", {
            conversationId: stored.thingId,
            reason,
            escalations,
        });
    }

    private async loadAssistant(key: string): Promise<Stored<Assistant> | undefined> {
        if (!key) return undefined;
        const found = await this.deps.things.search<Assistant>(
            SPECS.Assistant_DM,
            { operator: "exact_match", field: "/Assistant/Key", value: key },
            2,
        );
        return found[0];
    }

    private async write(stored: Stored<Conversation>): Promise<void> {
        await this.deps.things.update(CONVERSATION, stored.docRef, stored.data as Record<string, unknown>);
    }
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { OpenQuestion };
