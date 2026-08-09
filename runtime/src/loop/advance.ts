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
        /** The key, not the loaded Assistant: the unknown-assistant path has no Assistant to load. */
        assistantKey: string;
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

/**
 * The tool intent this Conversation wrote down but never recorded a result for.
 *
 * Its existence means exactly one thing: a Turn was interrupted between "we are about to do X"
 * and "X returned". The Operation may have completed or may never have started, and the whole
 * point of writing the intent first is that we must not guess.
 */
export function unresolvedIntent(conversation: Conversation): Entry | undefined {
    const entries = conversation.entries ?? [];
    const resolved = new Set(
        entries
            .filter((entry) => entry.kind === "tool-result")
            .map((entry) => entry.idempotencyKey ?? ""),
    );
    return entries
        .filter((entry) => entry.kind === "tool-intent")
        .find((entry) => !resolved.has(entry.idempotencyKey ?? ""));
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
            // Nothing ends silently, and this is the one path with no Assistant to escalate
            // *through* — so it escalates by key. Without this the Conversation would sit in
            // `failed` and never appear in the Open Questions view, which is exactly the
            // disappearance ADR-0015 forbids.
            await this.escalateByKey(
                stored,
                conversation.assistantKey ?? "(none)",
                "error",
                `This conversation names the Assistant "${conversation.assistantKey}", and no ` +
                    `Assistant with that key exists. It was probably renamed or deleted. ` +
                    `Restore it, or abandon this conversation.`,
            );
            return { status: conversation.status ?? "waiting", turnsRun: 0, note: "unknown assistant" };
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

        // --- reconcile an interrupted Turn before starting a new one ----------------------
        //
        // This is the half of the intent log that makes writing it worthwhile. Without it,
        // recovery calls the model again, the model re-issues the same tool call, and the new
        // call gets a NEW idempotency key (the un-answered intent is itself in the log, so the
        // sequence has moved on) — which is exactly how you book the same invoice twice.
        const unresolved = unresolvedIntent(conversation);
        if (unresolved) {
            const settled = await this.reconcile(stored, assistant, unresolved);
            if (!settled) {
                await this.escalate(
                    stored,
                    assistant,
                    "error",
                    `This conversation was interrupted while calling **${unresolved.toolName}**, ` +
                        `and I cannot tell whether that call took effect. Repeating it might do ` +
                        `the work twice, so I have stopped instead.\n\nCheck whether it happened, ` +
                        `then answer to tell me what to do.`,
                );
                return { status: conversation.status ?? "waiting", turnsRun: 0, note: "unreconcilable intent" };
            }
            await this.write(stored);
        }

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
            const tool =
                granted.find((candidate) => toolNameForLlm(candidate.name) === call.name) ??
                granted.find((candidate) => candidate.name === operationFromLlm(call.name));
            // Record the tool's OWN name, not the reverse-mapped wire name. `__` maps back to `.`
            // unconditionally, so `assistant.call:accountant` became `assistant.call.accountant` —
            // a name no tool has. Recovery then looked it up, failed, and told the model the call
            // "did not take effect", when in fact the child Conversation had already been born.
            // The model's natural response is to call again: two Accountants on one invoice.
            const operation = tool?.name ?? operationFromLlm(call.name);

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
                // A tool call with no result is invalid to both OpenAI and Anthropic — each
                // requires a tool message per tool call — so a suspended Conversation would fail
                // the moment it resumed against a real provider. It also has to be distinguishable
                // from a *crashed* call, which is what `unresolvedIntent` looks for. Both problems
                // are solved by recording the suspension as the result.
                appendEntry(conversation, {
                    role: "tool",
                    kind: "tool-result",
                    toolName: operation,
                    toolResult: JSON.stringify({
                        pending: true,
                        waitingFor: outcome.waitingFor,
                        note: outcome.note ?? "Suspended; the answer will arrive as a later message.",
                    }),
                    idempotencyKey,
                });
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
     * Ask the Connector whether an interrupted call landed. Never re-execute.
     *
     * Returns true when the question was settled (either way) and the transcript now has a result
     * for that intent; false when nothing can answer it, in which case the caller escalates.
     */
    private async reconcile(
        stored: Stored<Conversation>,
        assistant: Stored<Assistant>,
        intent: Entry,
    ): Promise<boolean> {
        const conversation = stored.data;
        const operation = intent.toolName ?? "";
        const key = intent.idempotencyKey ?? "";
        const tool = this.deps.registry
            .grantedTo(assistant.data)
            .find((candidate) => candidate.name === operation);

        log.warn("reconciling an interrupted tool call", {
            conversationId: stored.thingId,
            tool: operation,
            idempotencyKey: key,
        });

        if (!tool) {
            // The Operation is gone (renamed, or revoked from this Assistant). Nothing did it.
            appendEntry(conversation, {
                role: "tool",
                kind: "tool-result",
                toolName: operation,
                toolResult: `Error: this call was interrupted, and "${operation}" is no longer available, so it did not take effect.`,
                idempotencyKey: key,
            });
            return true;
        }

        if (!tool.mutating) {
            // Read-only: repeating it is free and cannot be wrong.
            appendEntry(conversation, {
                role: "tool",
                kind: "tool-result",
                toolName: operation,
                toolResult: "This call was interrupted. It only reads, so nothing was changed — ask again if you still need it.",
                idempotencyKey: key,
            });
            return true;
        }

        if (!tool.reconcile) return false;

        const context: ToolContext = { conversation: stored, assistant, idempotencyKey: key };
        let outcome: ToolOutcome | undefined;
        try {
            outcome = await tool.reconcile(safeParse(intent.toolArgs), context);
        } catch (error) {
            log.error("reconciliation itself failed", {
                tool: operation,
                error: describeError(error),
            });
            return false;
        }
        if (!outcome) return false;

        appendEntry(conversation, {
            role: "tool",
            kind: "tool-result",
            toolName: operation,
            toolResult:
                outcome.kind === "error"
                    ? `Error: ${outcome.message}`
                    : outcome.kind === "pending"
                      ? JSON.stringify({ pending: true, waitingFor: outcome.waitingFor })
                      : JSON.stringify(outcome.value ?? null),
            idempotencyKey: key,
        });
        return true;
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
     *
     * `failed` therefore means one of two things, and only these: the User abandoned it, or it
     * escalated more than `maxEscalations` times — at which point asking again is itself the
     * noise, and the Conversation stops with `lastError` explaining why.
     */
    private async escalate(
        stored: Stored<Conversation>,
        assistant: Stored<Assistant>,
        reason: FinishReason,
        message: string,
    ): Promise<void> {
        await this.escalateByKey(stored, assistant.data.key ?? "", reason, message);
    }

    private async escalateByKey(
        stored: Stored<Conversation>,
        assistantKey: string,
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
            conversation.finishReason = reason;
            conversation.leaseUntil = "";
            conversation.currentQuestionId = "";
            // The cap stops the loop, which is right — but it used to stop it *silently*: no
            // question, so the Conversation disappeared from the Open Questions view and the
            // User had no way to learn it had given up. `lastError` now says so in the words a
            // human needs, and the Conversation is still findable by its `failed` status.
            conversation.lastError =
                `${message}\n\nI have asked ${this.deps.maxEscalations} times and stopped. ` +
                `This conversation will not continue on its own — start a new one if the work ` +
                `still needs doing.`;
            await this.write(stored);
            log.error("conversation failed after repeated escalation", {
                conversationId: stored.thingId,
                escalations,
                reason,
            });
            return;
        }

        const idempotencyKey = `${stored.thingId}:escalation:${escalations}`;
        const questionId = await this.deps.raiseQuestion({
            conversation: stored,
            assistantKey,
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
