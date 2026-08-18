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

import { createHash } from "node:crypto";
import { log, describeError, describeForModel } from "../log.js";
import { nowIso, parseIso, SPECS, ThingRepository } from "../a12/things.js";
import type {
    Assistant,
    Conversation,
    Entry,
    FinishReason,
    OpenQuestion,
    Operation,
    Stored,
} from "../domain/types.js";
import { TransientLlmError, type LlmMessage, type LlmProvider, type LlmUsage } from "../llm/provider.js";
import {
    operationFromLlm,
    OperationRegistry,
    toolNameForLlm,
    toolSchemas,
    type DroppedGrant,
    type OperationContext,
    type GrantedOperation,
    type OperationOutcome,
    type Resolution,
} from "../operations/registry.js";

export interface AdvanceDeps {
    things: ThingRepository;
    registry: OperationRegistry;
    llm: LlmProvider;
    /** Set by the caller so ScriptedProvider can match on the current Assistant and turn. */
    setLlmContext(context: { assistantKey: string; turn: number }): void;
    leaseSeconds: number;
    maxEscalations: number;
    llmMaxAttempts: number;
    /**
     * What a Turn asks for when its Assistant names no model of its own — the active profile's
     * `model`, from `llm.json`. An Assistant that carries one still wins; this is what makes
     * switching profiles enough for the ones that do not.
     */
    defaultModel: string;
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

/**
 * How many more Turns an answered turns-exhausted escalation buys.
 *
 * Small on purpose: the point is to make the question answerable, not to remove the bound. Three
 * escalations is the cap, so this is the most a Conversation can gain three times over.
 */
const TURN_GRANT_ON_ESCALATION = 5;

/**
 * How many Entries a Conversation may hold, because that is what the Model allows.
 *
 * `Conversation_DM`'s `Entries` group is `repeatability: 100`. Nothing in the loop knew that, and the
 * consequence was the worst kind of failure: a Conversation that reached the limit could no longer be
 * written, so it could not be marked failed either, so it stayed runnable and the scan retried it
 * **every seven seconds for ever** — against an A12 validation error about row numbers, which reads
 * like a store fault rather than a full Conversation.
 *
 * Two caps disagreed and only one of them was written down. `maxTurns` defaults to 20 and is the one
 * everybody reasons about; a Turn writes several Entries — a prompt, a response, an intent, a
 * result — so a Conversation passes 100 Entries long before it runs out of Turns. This is the one
 * that actually binds.
 */
export const MAX_ENTRIES = 100;

/**
 * How many rows are kept back, so the end can be written down.
 *
 * A Turn appends as it goes and cannot un-append, so stopping exactly at the limit would leave no
 * room to say why it stopped — and [ADR-0015](../../../docs/adr/0015-nothing-ends-silently.md) is
 * that nothing ends silently. Five is enough for the epitaph plus the entries a Turn writes before it
 * could notice, without taking a meaningful bite out of a hundred.
 */
export const ENTRY_HEADROOM = 5;

/**
 * What the model is told when its call was refused for want of an approval.
 *
 * The generic pending wording — *"Suspended; the answer will arrive as a later message"* — would
 * tell the model its booking is on its way. It is not: nothing is queued, and the call has to be
 * made again once the answer arrives.
 */
/**
 * Why a Turn refuses to start against an empty catalogue, in the words the operator needs.
 *
 * It names the remedy rather than the symptom: an empty `Operation_DM` on a stack that is otherwise
 * up means `just up` ran and `just bootstrap` did not, which is a normal ordering rather than a
 * fault, and is fixed by one command.
 */
const EMPTY_CATALOGUE =
    "The Operation catalogue is empty: no Operation_DM Thing exists, so no Assistant can be " +
    "offered anything and no Turn can be taken. Bootstrap has not run — run `just bootstrap`.";

/** One page, unsorted: everything a Turn can see of the catalogue. See {@link LoopDriver.loadCatalogue}. */
const CATALOGUE_PAGE_SIZE = 100;

const REFUSED_PENDING_APPROVAL =
    "Refused pending approval, not queued. Nothing was booked and nothing is waiting to be. The " +
    "User has been asked to approve this exact call; when they answer you will be resumed, and you " +
    "must make the same call again — with the same arguments, or you will be asked again.";

export function nextSeq(conversation: Conversation): number {
    const entries = conversation.entries ?? [];
    return entries.reduce((max, entry) => Math.max(max, entry.seq ?? 0), 0) + 1;
}

/**
 * A stable fingerprint of the arguments a call was made with.
 *
 * The arguments arrive as the model produced them, so neither key order nor number formatting is
 * stable — and the approval is bound to the arguments, so the binding has to survive both. Keys are
 * sorted at every depth; array order is kept, because it is meaningful (the splits of a posting).
 * Numbers need no special handling: `JSON.stringify(96.50)` is already `96.5`.
 *
 * A model that re-issues the call with *different* arguments after a yes therefore misses its
 * approval and is asked again. That is the accepted failure mode: visible and safe, never a wrong
 * booking.
 */
export function canonicalArgsHash(args: Record<string, unknown>): string {
    return createHash("sha256").update(canonicalJson(args)).digest("hex");
}

function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        // An absent key and a key set to `undefined` are the same call.
        .filter(([, inner]) => inner !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonicalJson(inner)}`).join(",")}}`;
}

/**
 * Is there an approval in this Conversation for this Operation with these arguments?
 *
 * The walk-back is over two structured Entry kinds and one Open Question read by id. **The prose is
 * never parsed**: substring-matching a model-facing string is exactly the failure mode the
 * comparison document names as a thing never to start doing.
 *
 * The five states, and why each is distinct:
 *
 *   - `missing`  — nothing was ever asked for this pair, or what was asked has been deleted by hand.
 *                  Ask, and suspend.
 *   - `waiting`  — asked and not yet answered. Suspend on the question that already exists; asking a
 *                  second time would put two rows on the User's list for one decision.
 *   - `declined` — answered, and not with an explicit yes. Terminal for this pair: the Assistant is
 *                  told plainly and is not asked again, because re-asking a User who has said no is
 *                  how a safety feature becomes a thing people click through.
 *   - `consumed` — the yes was already spent by an earlier call. Two identical bookings need two
 *                  approvals, or one yes places the same transaction twice under two idempotency
 *                  keys (ADR-0012).
 *   - `valid`    — execute.
 */
export type ApprovalState =
    | { state: "missing" }
    | { state: "waiting"; questionId: string }
    | { state: "declined"; questionId: string; reason: string }
    | { state: "consumed"; questionId: string }
    | { state: "valid"; questionId: string };

export async function findApproval(
    conversation: Conversation,
    operation: string,
    argsHash: string,
    loadQuestion: (questionId: string) => Promise<OpenQuestion | undefined>,
): Promise<ApprovalState> {
    const entries = conversation.entries ?? [];
    const request = approvalRequestsFor(conversation, operation, argsHash).at(-1);
    if (!request) return { state: "missing" };

    const questionId = request.questionId ?? "";
    const question = await loadQuestion(questionId);
    // Deleted by hand. Waiting on a question that no longer exists would wait forever, and the
    // watcher's own answered scan takes the same view of a vanished question.
    if (!question) return { state: "missing" };

    if (question.confirmed !== true) {
        // `isAnswered()` is deliberately generous — any answer field filled in counts, because
        // nothing stamps `answeredAt` — so a User who typed a sentence and left the tri-state
        // Boolean alone has answered, and the watcher will resume this Conversation on that basis.
        // Anything that is not an explicit yes is therefore a no. Treating it as "still waiting"
        // would loop until `maxTurns`; treating it as a fresh ask would re-ask a question that has
        // been answered.
        //
        // Not `isAnswered` itself: importing it from the watcher would close a module cycle
        // (watcher → advance → watcher), and this is a rule about approvals rather than about
        // answers in general.
        if (question.confirmed === false) {
            return { state: "declined", questionId, reason: "The User declined this booking." };
        }
        if (question.text?.trim() || question.choice?.trim() || question.answeredAt) {
            return {
                state: "declined",
                questionId,
                reason:
                    "The User answered without confirming, which is not an approval. Nothing was " +
                    "booked. If you still believe it should be, say so and let them decide.",
            };
        }
        return { state: "waiting", questionId };
    }

    // Answered in the store, but the watcher has not appended the answer yet — possible on a
    // recovery path. Suspend; the answered scan will append it and resume this Conversation.
    const answer = entries.find((entry) => entry.kind === "answer" && entry.questionId === questionId);
    if (!answer) return { state: "waiting", questionId };

    // **Spent means executed, not merely attempted.** The tool-result that carries this `argsHash` is
    // written only where the Operation ran and returned a value ({@link stampSpentApproval}), so a
    // refusal and a rejection do not consume anything.
    //
    // The looser rule — *any* tool-result for this Operation after the answer — is what the change's
    // architecture prescribed, and it is wrong on the most ordinary path there is: Firefly refuses a
    // posting with a 422, the model retries the identical call as `postTransaction`'s own description
    // invites it to ("Safe to retry"), and the User is asked a second time for a booking that has
    // never happened. That is the question-per-retry this whole mechanism exists to bound.
    const spent = entries.some(
        (entry) =>
            entry.kind === "tool-result" &&
            entry.toolName === operation &&
            entry.argsHash === argsHash &&
            (entry.seq ?? 0) > (answer.seq ?? 0),
    );
    return spent ? { state: "consumed", questionId } : { state: "valid", questionId };
}

/**
 * Record that an approval was spent, on the result of the call that spent it.
 *
 * Called only when the Operation required an approval, the approval was valid, and the call returned
 * a **value** — so two identical bookings still need two approvals (ADR-0012), while a booking that
 * was refused or rejected leaves its approval intact.
 */
export function stampSpentApproval(result: Entry, argsHash: string): void {
    result.argsHash = argsHash;
}

function approvalRequestsFor(
    conversation: Conversation,
    operation: string,
    argsHash: string,
): Entry[] {
    return (conversation.entries ?? []).filter(
        (entry) =>
            entry.kind === "approval-request" &&
            entry.toolName === operation &&
            entry.argsHash === argsHash,
    );
}

/**
 * How the approval question reads.
 *
 * The fallback exists so the check never blocks on a missing renderer; it is not the intended
 * experience. A JSON blob in the inbox is how a safety feature becomes a thing the User clicks yes
 * on without reading.
 */
export function renderApprovalPrompt(operation: GrantedOperation, args: Record<string, unknown>): string {
    const described = operation.describeCall?.(args)?.trim();
    const body = described
        ? described
        : [
              `Approve calling **${operation.name}** with these arguments?`,
              ``,
              "```json",
              JSON.stringify(args, null, 2),
              "```",
          ].join("\n");
    return [
        `**Approval needed.**`,
        ``,
        body,
        ``,
        `Confirm to let it go ahead. Nothing happens unless you do.`,
    ].join("\n");
}

/**
 * Has this Conversation run out of room to record anything more?
 *
 * Pure, and exported so the bound can be asserted directly rather than inferred from a store that
 * refuses a write. See {@link MAX_ENTRIES} for why the bound exists and why it is not `maxTurns`.
 */
export function isFull(conversation: Conversation): boolean {
    return (conversation.entries ?? []).length + ENTRY_HEADROOM > MAX_ENTRIES;
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

        // Before anything appends: is there room left to append into? A Conversation that has filled
        // its Entries group cannot be written at all, which means it cannot even be marked failed —
        // so this has to be checked before the Turn starts rather than discovered when the write is
        // refused.
        if (isFull(conversation)) {
            await this.endBecauseFull(stored);
            return { status: "failed", turnsRun: 0, note: "entries full" };
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
            // The grant is what makes the question answerable. Without it the guard returned with
            // the budget untouched, so the answer arrived into a Conversation still at its limit
            // and the next Turn re-entered this same branch: three identical questions, then
            // `failed`, without a single Turn having been taken. ADR-0015 asks for an Open Question
            // here rather than a silent stop — and a question the User cannot act on is the silent
            // stop with extra steps.
            //
            // Escalation is still capped at three, so the worst case is three asks and three
            // grants, each following real work.
            conversation.maxTurns = maxTurns + TURN_GRANT_ON_ESCALATION;
            await this.escalate(
                stored,
                assistant,
                "limit",
                `This conversation reached its limit of ${maxTurns} turns without finishing.\n\n` +
                    `Answer to let it run ${TURN_GRANT_ON_ESCALATION} more turns, or leave it to stop here.`,
            );
            return { status: conversation.status ?? "waiting", turnsRun: 0, note: "max turns" };
        }

        conversation.status = "running";
        conversation.waitingFor = "";

        // One read, and everything this Turn resolves comes out of it (ADR-0019).
        const catalogue = await this.loadCatalogue();
        // One **resolution**, too. The three places that need it — the schemas offered to the model,
        // the belt check on what it called, and reconciliation of an interrupted call — used to
        // resolve the grants separately, which put two or three identical `warn` lines in the log
        // per Turn for one mistyped grant, forever. Resolving once is also what makes
        // architecture.md's "the schemas offered to the LLM are derived from the same call" true
        // rather than approximately true.
        const resolution = this.deps.registry.grantedTo(assistant.data, catalogue);

        // --- reconcile an interrupted Turn before starting a new one ----------------------
        //
        // This is the half of the intent log that makes writing it worthwhile. Without it,
        // recovery calls the model again, the model re-issues the same tool call, and the new
        // call gets a NEW idempotency key (the un-answered intent is itself in the log, so the
        // sequence has moved on) — which is exactly how you book the same invoice twice.
        const unresolved = unresolvedIntent(conversation);
        if (unresolved) {
            const outcome = await this.reconcile(stored, assistant, unresolved, resolution);
            if (!outcome) {
                // The intent gets a result even though nothing could answer it, for two reasons.
                // `unresolvedIntent` would otherwise find it again on the next wake and escalate
                // again — one question per scan, which is the noise ADR-0015's cap exists to
                // prevent, except that answering could never clear it. And a tool call with no
                // tool result is rejected outright by both OpenAI and Anthropic, so the
                // Conversation could not reach a real model afterwards either.
                //
                // It says **unknown**, not failed: ADR-0012 requires an intent without a result to
                // be treated as unknown, never as failed, and "Error: …" reads as failed and
                // invites the retry that could do the work twice. JSON, matching the shape the
                // ordinary pending result already uses, so a model that has learned one reads the
                // other.
                appendEntry(conversation, {
                    role: "tool",
                    kind: "tool-result",
                    toolName: unresolved.toolName ?? "",
                    toolResult: JSON.stringify({
                        interrupted: true,
                        outcome: "unknown",
                        retry: false,
                        note:
                            "This call was interrupted and nothing can say whether it took effect. " +
                            "Treat it as unknown — it may have completed. Do not call it again: the " +
                            "User has been asked to check, and their answer will arrive as a message.",
                    }),
                    idempotencyKey: unresolved.idempotencyKey ?? "",
                });
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
            // `pending` means the suspension still holds — the question is still open, the payment
            // still unmade. Falling through to a fresh Turn here let the Conversation reach `done`
            // without the answer, and cleared the `currentQuestionId` that was the only way back.
            if (outcome.kind === "pending") {
                return this.suspend(stored, unresolved.toolName ?? "", outcome, 0);
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
            response = await this.callLlmWithRetries(assistant.data, conversation, resolution);
        } catch (error) {
            // The User reads this one as an Open Question, so it says what happened rather than
            // where. The stack goes to the log, where the person who needs it is looking.
            log.error("the language model could not be reached", {
                conversationId: stored.thingId,
                error: describeError(error),
            });
            await this.escalate(
                stored,
                assistant,
                "error",
                `The language model could not be reached: ${describeForModel(error)}`,
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
            // The Turn's cost goes on the first Entry it wrote, which for a text reply is this one.
            recordUsage(
                appendEntry(conversation, { role: "assistant", kind: "assistant", text: response.text }),
                response.usage,
            );
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
        const { granted, dropped } = resolution;
        /**
         * A Turn that ends `wants-tools` appends no `assistant` Entry at all — only one
         * `tool-intent` per call — so "the Turn's assistant Entry" names a row that does not exist
         * for most Turns. The cost goes on the first Entry the Turn wrote, which here is the first
         * intent, and it is set before the write that the intent-before-execution rule already does.
         */
        let costEntry: Entry | undefined;

        for (const call of response.toolCalls) {
            const resolved =
                granted.find((candidate) => toolNameForLlm(candidate.name) === call.name) ??
                granted.find((candidate) => candidate.name === operationFromLlm(call.name));
            // Record the Operation's OWN name, not the reverse-mapped wire name. `__` maps back to `.`
            // unconditionally, so `assistant.call:accountant` became `assistant.call.accountant` —
            // a name no Operation has. Recovery then looked it up, failed, and told the model the call
            // "did not take effect", when in fact the child Conversation had already been born.
            // The model's natural response is to call again: two Accountants on one invoice.
            //
            // A grant that was *dropped* has no resolved Operation to take the name from, and it is
            // the likeliest case of all — the User switched `assistant.call` off — so the drop is
            // consulted next, matched by wire name because that is the direction the mangling is
            // total in. Only a call that matches nothing at all falls back to the reverse mapping.
            const operation =
                resolved?.name ??
                dropped.find((candidate) => toolNameForLlm(candidate.key) === call.name)?.key ??
                operationFromLlm(call.name);

            const seq = nextSeq(conversation);
            const idempotencyKey = `${stored.thingId}:${seq}`;

            // The intent is written BEFORE the operation runs, so recovery can ask what landed.
            const intent = appendEntry(conversation, {
                role: "assistant",
                kind: "tool-intent",
                // The Turn's prose belongs on the first intent only, exactly as its usage does
                // (`costEntry` below). Copied onto every intent, `buildMessages` replays the same
                // narration once per call — wasted prompt tokens next Turn, and the User sees the
                // sentence twice.
                text: costEntry ? "" : response.text,
                toolName: operation,
                toolArgs: JSON.stringify(call.arguments),
                idempotencyKey,
            });
            if (!costEntry) {
                recordUsage(intent, response.usage);
                costEntry = intent;
            }
            await this.write(stored);

            if (!resolved) {
                // An Operation that was never offered should be unreachable — the registry does not
                // put it in the schemas — so this is a belt, and there is a test for it. What it
                // *says* is not a belt: after ADR-0019 the likeliest reason a granted Operation is
                // missing is that the User switched it off, and the drop reason is the only thing
                // that can tell the model the truth about that.
                appendEntry(conversation, {
                    role: "tool",
                    kind: "tool-result",
                    toolName: operation,
                    toolResult: unresolvedCallMessage(operation, call.name, dropped, granted),
                    idempotencyKey,
                });
                continue;
            }

            const context: OperationContext = { conversation: stored, assistant, idempotencyKey };
            let outcome: OperationOutcome;
            // The approval check goes HERE — after the intent is written, before the Operation runs.
            // That position is not incidental: the intent is already in the transcript, so a refusal
            // is visible in the Conversation rather than inferred from its absence, and it is the
            // same place a `pending` outcome is handled, so the refusal path is the existing path.
            const argsHash = resolved.requiresApproval ? canonicalArgsHash(call.arguments) : undefined;
            const refusal = argsHash
                ? await this.gateOnApproval(stored, assistant, resolved, call.arguments, argsHash)
                : undefined;
            if (refusal) {
                outcome = refusal;
            } else {
                try {
                    outcome = await resolved.execute(call.arguments, context);
                } catch (error) {
                    // Recoverable by the model: it sees the error as a tool result and self-corrects.
                    // Which requires the message to say what was wrong — so the model gets the
                    // Authority's own reason, and the operator gets the stack in the log. Putting the
                    // stack in the transcript instead gave the model nothing to correct against, cost
                    // tokens on every failure, and leaked host paths into the prompt.
                    log.error("a tool call threw", {
                        conversationId: stored.thingId,
                        operation,
                        error: describeError(error),
                    });
                    outcome = { kind: "error", message: describeForModel(error) };
                }
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
                return this.suspend(stored, operation, outcome, 1);
            }

            const result = appendEntry(conversation, {
                role: "tool",
                kind: "tool-result",
                toolName: operation,
                toolResult:
                    outcome.kind === "error"
                        ? `Error: ${outcome.message}`
                        : JSON.stringify(outcome.value ?? null),
                idempotencyKey,
            });
            // The approval is spent by a call that ran and returned a value, and by nothing else.
            if (argsHash && !refusal && outcome.kind === "value") {
                stampSpentApproval(result, argsHash);
            }

            // An Operation may spend money on a model of its own — `document.readScan` sends a PDF
            // to the vision profile — without that spend being the Turn's own LLM call. Summing a
            // Conversation's Turns is meant to give an honest **lower bound**, understated only by
            // Turns that errored; an Operation billing silently would open a second category of
            // unrecorded spend, and unlike the first it would grow with ordinary successful use.
            // So it goes onto the same Entry, added to what the Turn already recorded, because it
            // was spent by this Turn and there is nowhere more truthful to put it.
            if (outcome.kind === "value" && costEntry) {
                addUsage(costEntry, operationUsage(outcome.value));
            }
        }

        conversation.leaseUntil = "";
        conversation.status = "running";
        await this.write(stored);
        return { status: "running", turnsRun: 1 };
    }

    /**
     * The Operation catalogue, read once at the top of a Turn.
     *
     * One unconstrained query over a table of seventeen rows, with **no cache and no TTL**: a cache
     * would add a second answer to "what can this Assistant do" and a window in which it is stale,
     * to save a query nobody will notice. One snapshot per Turn rather than one per call site is
     * also what stops a User editing the catalogue mid-Turn from producing a Turn whose offered
     * schemas and executed Operations disagree.
     *
     * **No fallback to the seeds.** An empty catalogue throws, before the provider is called: the
     * Turn is not spent against `maxTurns`, the lease never reaches the store, the next scan
     * retries, and if it persists the heartbeat goes stale and the healthcheck fails — the path
     * ADR-0015 built for exactly this. Running quietly on a catalogue nobody configured is the one
     * failure this system cannot afford, because the catalogue is where approvals are decided.
     */
    private async loadCatalogue(): Promise<Operation[]> {
        const found = await this.deps.things.search<Operation>(
            SPECS.Operation_DM,
            undefined,
            CATALOGUE_PAGE_SIZE,
        );
        if (found.length === 0) {
            log.error(EMPTY_CATALOGUE);
            throw new Error(EMPTY_CATALOGUE);
        }
        if (found.length >= CATALOGUE_PAGE_SIZE) {
            // One page, and the store promises no order — so past the ceiling *which* Operations a
            // Turn can see is arbitrary, and a grant naming one of the missing ones is dropped as
            // `absent`, which tells the model the Operation does not exist. That is a lie worth a
            // line in the log rather than a silence: seventeen Implementations ship, so reaching
            // this means Operations were created by hand and the page has to grow.
            log.warn("the Operation catalogue filled a whole page; some Operations may be invisible", {
                pageSize: CATALOGUE_PAGE_SIZE,
            });
        }
        return found.map((stored) => stored.data);
    }

    /**
     * The refusal, or `undefined` when the call may go ahead.
     *
     * The model does not have to know this rule: an Assistant whose prompt forgot to ask still
     * cannot book — it simply gets asked on the model's behalf and is resumed with the answer.
     *
     * Note what this does *not* do: it never goes through `escalate()`. A missing approval is the
     * ordinary path, not a stuck Conversation, and `escalate()` would increment `escalationCount` —
     * so three unapproved bookings would mark the Conversation `failed`. It also sets no `wakeAt`,
     * following `ui.askUser`: an unanswered approval waits, it does not lapse into a booking.
     */
    private async gateOnApproval(
        stored: Stored<Conversation>,
        assistant: Stored<Assistant>,
        operation: GrantedOperation,
        args: Record<string, unknown>,
        argsHash: string,
    ): Promise<OperationOutcome | undefined> {
        const approval = await findApproval(stored.data, operation.name, argsHash, (questionId) =>
            this.loadQuestion(questionId),
        );

        switch (approval.state) {
            case "valid":
                return undefined;
            case "declined":
                // Terminal for this pair, and an ordinary tool error the model can self-correct
                // against. NOT `pending`: a second question would be raised on every retry, capped
                // only by `maxTurns`.
                log.info("an operation requiring approval was declined", {
                    conversationId: stored.thingId,
                    operation: operation.name,
                });
                return { kind: "error", message: approval.reason };
            case "waiting":
                return {
                    kind: "pending",
                    waitingFor: "user",
                    questionId: approval.questionId,
                    note: REFUSED_PENDING_APPROVAL,
                };
            case "missing":
            case "consumed": {
                const questionId = await this.raiseApproval(stored, assistant, operation, args, argsHash);
                log.info("an operation requiring approval was refused and the User was asked", {
                    conversationId: stored.thingId,
                    operation: operation.name,
                    questionId,
                    // Which of the two it was matters when reading a log: a consumed approval means
                    // the model asked to do the same thing twice.
                    because: approval.state,
                });
                return {
                    kind: "pending",
                    waitingFor: "user",
                    questionId,
                    note: REFUSED_PENDING_APPROVAL,
                };
            }
        }
    }

    /**
     * Ask the User to approve one Operation with one set of arguments, and record that we did.
     *
     * The question is raised before the Entry is appended, so a crash in between leaves an Open
     * Question with no record of it. That is why the idempotency key is derived from the arguments
     * and the attempt number rather than from the entry sequence: the retry computes the same key,
     * `create` finds the question already there, and the orphan is adopted rather than duplicated.
     */
    private async raiseApproval(
        stored: Stored<Conversation>,
        assistant: Stored<Assistant>,
        operation: GrantedOperation,
        args: Record<string, unknown>,
        argsHash: string,
    ): Promise<string> {
        const conversation = stored.data;
        const attempt = approvalRequestsFor(conversation, operation.name, argsHash).length + 1;
        const questionId = await this.deps.raiseQuestion({
            conversation: stored,
            assistantKey: assistant.data.key ?? "",
            kind: "confirm",
            prompt: renderApprovalPrompt(operation, args),
            // Short enough for the store's 100-character `exact_match` ceiling; the (Operation,
            // argsHash) pair is matched by the walk-back, so the key only has to separate attempts.
            idempotencyKey: `approval:${stored.thingId}:${argsHash.slice(0, 16)}:${attempt}`,
        });
        appendEntry(conversation, {
            role: "system",
            kind: "approval-request",
            toolName: operation.name,
            argsHash,
            questionId,
        });
        return questionId;
    }

    private async loadQuestion(questionId: string): Promise<OpenQuestion | undefined> {
        if (!questionId) return undefined;
        try {
            const found = await this.deps.things.get<OpenQuestion>(
                SPECS.OpenQuestion_DM,
                `OpenQuestion_DM/${questionId}`,
            );
            return found.data;
        } catch {
            return undefined;
        }
    }

    /**
     * Put the Conversation back to sleep.
     *
     * The **only** writer of the suspended state, deliberately: the normal pending path and the
     * recovery path both need it, and keeping two copies is what let recovery forget to set
     * `status`, `waitingFor` and `currentQuestionId` and finish a Conversation whose question was
     * still open.
     */
    private async suspend(
        stored: Stored<Conversation>,
        operation: string,
        outcome: Extract<OperationOutcome, { kind: "pending" }>,
        turnsRun: number,
    ): Promise<AdvanceResult> {
        const conversation = stored.data;
        conversation.status = "waiting";
        conversation.waitingFor = outcome.waitingFor;
        conversation.wakeAt = outcome.wakeAt ?? "";
        conversation.currentQuestionId = outcome.questionId ?? "";
        conversation.leaseUntil = "";
        await this.write(stored);
        log.info("conversation suspended", {
            conversationId: stored.thingId,
            waitingFor: outcome.waitingFor,
            operation,
        });
        return { status: "waiting", turnsRun, note: `pending ${operation}` };
    }

    /**
     * Ask the Connector whether an interrupted call landed. Never re-execute.
     *
     * Returns the Operation's own verdict — and `undefined` when nothing can answer, in which case
     * the caller escalates. The verdict is returned rather than a boolean because a `pending` one
     * means something quite different from "settled": the suspension still holds, and the caller
     * has to honour it instead of taking a Turn. Either way the transcript now carries a result for
     * the intent, so `unresolvedIntent` will not find it again.
     */
    private async reconcile(
        stored: Stored<Conversation>,
        assistant: Stored<Assistant>,
        intent: Entry,
        resolution: Resolution,
    ): Promise<OperationOutcome | undefined> {
        const conversation = stored.data;
        const operation = intent.toolName ?? "";
        const key = intent.idempotencyKey ?? "";
        const resolved = resolution.granted.find((candidate) => candidate.name === operation);

        log.warn("reconciling an interrupted tool call", {
            conversationId: stored.thingId,
            operation,
            idempotencyKey: key,
        });

        const settle = (verdict: OperationOutcome, text: string): OperationOutcome => {
            const result = appendEntry(conversation, {
                role: "tool",
                kind: "tool-result",
                toolName: operation,
                toolResult: text,
                idempotencyKey: key,
            });
            // A reconciled call that DID land spent its approval, exactly as an ordinary one does.
            // Without this a crash between the booking and its result would leave the approval
            // looking unspent, and one yes could place the same transaction twice.
            if (resolved?.requiresApproval && verdict.kind === "value") {
                stampSpentApproval(result, canonicalArgsHash(safeParse(intent.toolArgs)));
            }
            return verdict;
        };

        if (!resolved) {
            // The Operation is gone (renamed, or revoked from this Assistant). Nothing did it.
            return settle(
                { kind: "error", message: `"${operation}" is no longer available` },
                `Error: this call was interrupted, and "${operation}" is no longer available, so it did not take effect.`,
            );
        }

        if (!resolved.mutating) {
            // Read-only: repeating it is free and cannot be wrong.
            return settle(
                { kind: "value", value: null },
                "This call was interrupted. It only reads, so nothing was changed — ask again if you still need it.",
            );
        }

        if (!resolved.reconcile) return undefined;

        const context: OperationContext = { conversation: stored, assistant, idempotencyKey: key };
        let outcome: OperationOutcome | undefined;
        try {
            outcome = await resolved.reconcile(safeParse(intent.toolArgs), context);
        } catch (error) {
            log.error("reconciliation itself failed", {
                operation,
                error: describeError(error),
            });
            return undefined;
        }
        if (!outcome) return undefined;

        return settle(
            outcome,
            outcome.kind === "error"
                ? `Error: ${outcome.message}`
                : outcome.kind === "pending"
                  ? JSON.stringify({ pending: true, waitingFor: outcome.waitingFor })
                  : JSON.stringify(outcome.value ?? null),
        );
    }

    /**
     * Transient failures are retried inside the Turn with bounded backoff; each attempt is
     * recorded so the transcript explains itself later.
     */
    private async callLlmWithRetries(
        assistant: Assistant,
        conversation: Conversation,
        resolution: Resolution,
    ) {
        const messages = buildMessages(assistant, conversation);
        const tools = toolSchemas(resolution.granted);
        const model = assistant.llmModel || this.deps.defaultModel;

        let lastError: unknown;
        for (let attempt = 1; attempt <= this.deps.llmMaxAttempts; attempt += 1) {
            try {
                return await this.deps.llm.complete({ model, messages, tools });
            } catch (error) {
                lastError = error;
                if (!(error instanceof TransientLlmError)) throw error;
                // `describeForModel`, not `describeError`: this Entry has three readers and a stack
                // trace serves none of them. It goes back to the model on the next Turn, where it
                // costs tokens and cannot be acted on; and since the transcript became something a
                // human reads, it is now shown to the **User** — who is owed a sentence about what
                // went wrong, not `/app/src/llm/openai.ts:151:19`. The stack is logged instead, so
                // an operator loses nothing.
                log.warn("a transient model error", {
                    assistant: assistant.key,
                    attempt,
                    error: describeError(error),
                });
                appendEntry(conversation, {
                    role: "system",
                    kind: "error",
                    text: `Transient model error on attempt ${attempt}: ${describeForModel(error)}`,
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

    /**
     * End a Conversation that has no room left to record anything, and say so.
     *
     * It ends as `failed` rather than `done` because nothing was concluded — the work stopped
     * because the record filled up, which is a different thing from finishing, and the User may want
     * to start a fresh Conversation for whatever was left. `lastError` carries that in words, because
     * a status alone would be the silent stop ADR-0015 forbids.
     *
     * **The epitaph is appended only if there is room for it.** A Conversation that is already at the
     * Model's limit — one that filled up before this guard existed — cannot take another row, and
     * trying is precisely the write that fails. In that case the reason goes in `lastError` only, and
     * the Conversation still ends. Recovering the stuck ones matters more than recording the ending
     * twice.
     */
    private async endBecauseFull(stored: Stored<Conversation>): Promise<void> {
        const conversation = stored.data;
        const held = (conversation.entries ?? []).length;
        const reason =
            `This conversation filled up: it holds ${held} of the ${MAX_ENTRIES} entries a ` +
            `conversation can record, so nothing further can be written to it. It has stopped here. ` +
            `Start a new one if the work still needs doing.`;

        if (held < MAX_ENTRIES) {
            appendEntry(conversation, { role: "system", kind: "error", text: reason });
        }

        conversation.status = "failed";
        conversation.finishReason = "limit";
        conversation.waitingFor = "";
        conversation.leaseUntil = "";
        conversation.currentQuestionId = "";
        conversation.lastError = reason;

        await this.write(stored);
        log.error("conversation ran out of entries and was stopped", {
            conversationId: stored.thingId,
            assistant: conversation.assistantKey,
            entries: held,
            maxEntries: MAX_ENTRIES,
        });
    }

    private async write(stored: Stored<Conversation>): Promise<void> {
        await this.deps.things.update(CONVERSATION, stored.docRef, stored.data as Record<string, unknown>);
    }
}

/**
 * What the model is told when the Operation it called resolved to nothing.
 *
 * The drop reason is matched by **wire name**, not by the Operation name: `assistant.call:accountant`
 * comes back from the provider as `assistant__call__accountant`, and `operationFromLlm` maps `__` to
 * `.` unconditionally — so the reverse-mapped name is `assistant.call.accountant`, which matches no
 * grant. Comparing in the direction the mapping is total gets the per-callee grants right.
 *
 * Each sentence is one the User could be shown beside the Assistant's own definition, because in
 * every case except the last the grant is still sitting there.
 */
function unresolvedCallMessage(
    operation: string,
    wireName: string,
    dropped: DroppedGrant[],
    granted: GrantedOperation[],
): string {
    const drop =
        dropped.find((candidate) => toolNameForLlm(candidate.key) === wireName) ??
        dropped.find((candidate) => candidate.key === operation);
    const named = `"${drop?.key ?? operation}"`;
    // Never granted at all is the only case where "you do not have it" is the whole truth.
    const reason = drop ? DROP_REASONS[drop.reason](named) : `${named} is not granted to you.`;
    const available = granted.map((candidate) => candidate.name);
    return `Error: ${reason} ${
        available.length > 0
            ? `Available: ${available.join(", ")}`
            : "You have no Operations available at all."
    }`;
}

/**
 * One sentence per drop reason. A `Record` over the union rather than a chain of ifs, so a seventh
 * reason cannot be added without deciding what the model is told about it.
 */
const DROP_REASONS: Record<DroppedGrant["reason"], (named: string) => string> = {
    disabled: (named) =>
        `${named} is switched off. The User has disabled it, so nothing was done; ask them if you need it.`,
    unimplemented: (named) => `${named} is no longer implemented, so there is nothing to call.`,
    absent: (named) => `${named} is granted to you, but no such Operation exists in this system.`,
    unparseable: (named) =>
        `${named} is misconfigured: its parameters are not valid JSON, so it cannot be called.`,
    "self-call": (named) => `${named} would call yourself, which is not permitted.`,
    "bare-call": (named) =>
        `${named} is not a wildcard: name the Assistant you mean, as "assistant.call:<key>".`,
};

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stamp what the model charged onto the Entry the Turn wrote first.
 *
 * Nothing when the provider reported nothing — a Turn killed by a thrown `TransientLlmError`, or one
 * ending `finishReason: "error"`, which escalates without appending an assistant Entry at all. The
 * consequence is stated rather than papered over: the Turns of a Conversation sum to a **lower
 * bound** on its cost, not to its cost.
 */
function recordUsage(entry: Entry, usage: LlmUsage | undefined): void {
    if (!usage) return;
    entry.promptTokens = usage.promptTokens;
    entry.completionTokens = usage.completionTokens;
}

/**
 * What an Operation reports having spent on a model of its own, or nothing.
 *
 * The value is whatever the Operation chose to return, so this narrows rather than casts: a result
 * with no `usage`, or one whose `usage` is not two finite non-negative numbers, changes nothing at
 * all. Silently recording a wrong number would be worse than recording none, since the whole point
 * of the figure is that it can be trusted as a floor.
 *
 * Negative is the case worth naming. `Number.isFinite(-999999)` is `true`, so a `usage` block with
 * a negative count would pass a finiteness check and then *subtract* from the Turn — turning the
 * lower bound a Conversation's cost is documented to be into a number below the truth, which is the
 * one failure mode the floor exists to rule out. D-054 supports pointing a profile at a local
 * server, and an odd `usage` block is likeliest to come from exactly there.
 *
 * A partially-bad pair contributes **nothing**, not its good half. The two numbers come from one
 * report by one Operation, and an Operation that got one of them wrong has given no reason to
 * believe the other; half a pair recorded as a whole one reads, downstream, as a Turn that
 * genuinely spent zero completion tokens rather than as a report that was not trustworthy.
 */
function operationUsage(value: unknown): LlmUsage | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const usage = (value as { usage?: unknown }).usage;
    if (typeof usage !== "object" || usage === null) return undefined;
    const { promptTokens, completionTokens } = usage as {
        promptTokens?: unknown;
        completionTokens?: unknown;
    };
    if (typeof promptTokens !== "number" || !Number.isFinite(promptTokens) || promptTokens < 0) {
        return undefined;
    }
    if (
        typeof completionTokens !== "number" ||
        !Number.isFinite(completionTokens) ||
        completionTokens < 0
    ) {
        return undefined;
    }
    return { promptTokens, completionTokens };
}

/** Add to what the Entry already carries; an Entry with nothing on it starts from zero. */
function addUsage(entry: Entry, usage: LlmUsage | undefined): void {
    if (!usage) return;
    entry.promptTokens = (entry.promptTokens ?? 0) + usage.promptTokens;
    entry.completionTokens = (entry.completionTokens ?? 0) + usage.completionTokens;
}

export type { OpenQuestion };
