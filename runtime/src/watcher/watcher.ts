/**
 * The trigger watcher.
 *
 * This is the component none of the three agent systems surveyed in AGENTIC_LOOP.md has, because
 * all three are born from a human typing. Ours has to notice work by itself, so it scans the
 * ThingStore — which is also the only Authority for pending work (ADR-0004), so there is nothing
 * else it *could* scan.
 *
 * Six scans. Birth is exactly-once by query rather than by timing: a Thing does not birth a
 * Conversation if one already exists for `(assistantKey, subjectThingId)`.
 */

import { log, describeError } from "../log.js";
import {
    and,
    eq,
    nowIso,
    not,
    parseIso,
    path as fieldPath,
    setButNot,
    SPECS,
    ThingRepository,
    unset,
} from "../a12/things.js";
import type { ModelSpec } from "../a12/things.js";
import type { Constraint } from "../a12/client.js";
import {
    isTriggerEligible,
    TRIGGER_ELIGIBLE_MODELS,
    type Assistant,
    type Conversation,
    type OpenQuestion,
    type RuntimeState,
    type Stored,
    type ThingModel,
} from "../domain/types.js";
import { appendEntry, LoopDriver } from "../loop/advance.js";

export interface WatcherDeps {
    things: ThingRepository;
    driver: LoopDriver;
    maxBirthsPerHour: number;
    /** Create a Conversation for an Assistant, about a Thing. Returns its docRef. */
    birth(input: {
        assistant: Stored<Assistant>;
        subjectThingId?: string;
        subjectModel?: string;
        prompt: string;
        title: string;
        parentConversationId?: string;
        idempotencyKey: string;
    }): Promise<string>;
}

export const RUNTIME_STATE_KEY = "the-one";

export interface ScanReport {
    births: number;
    continuations: number;
    paused: boolean;
    errors: number;
}

export class Watcher {
    constructor(private readonly deps: WatcherDeps) {}

    /** One pass. Returns what it did, so the caller can log and stamp the heartbeat. */
    async scan(): Promise<ScanReport> {
        const report: ScanReport = { births: 0, continuations: 0, paused: false, errors: 0 };

        const state = await this.loadState();
        if (state.data.paused) {
            report.paused = true;
            return report;
        }

        const assistants = (
            await this.deps.things.search<Assistant>(SPECS.Assistant_DM, undefined, 100)
        ).filter((assistant) => assistant.data.enabled !== false);

        // Scan 1 — Things that have materialised
        report.births += await this.scanMaterialised(state, assistants);
        // Scan 2 — the User has answered
        report.continuations += await this.scanAnswered();
        // Scan 3 — wakeAt has passed
        report.continuations += await this.scanWoken();
        // Scan 4 — a lease has expired: the Runtime died mid-Turn
        report.continuations += await this.scanExpiredLeases();
        // Scan 5 — a child has finished and its parent has not been told
        report.continuations += await this.scanResultDelivery();
        // Scan 6 — running Conversations that simply need their next Turn
        report.continuations += await this.scanRunnable();

        await this.stampHeartbeat(state);
        return report;
    }

    // ---------------------------------------------------------------- scan 1: birth

    private async scanMaterialised(
        state: Stored<RuntimeState>,
        assistants: Stored<Assistant>[],
    ): Promise<number> {
        const triggered = assistants.filter((assistant) =>
            (assistant.data.triggers ?? []).some((trigger) => trigger.kind === "thing-materialised"),
        );
        if (triggered.length === 0) return 0;

        const watermark = state.data.watermark;
        const seen = new Set((state.data.watermarkDocRefs ?? []).map((row) => row.docRef ?? ""));
        let births = 0;
        let newestSeen = watermark ?? "";
        const boundaryDocRefs: string[] = [];

        if (!this.withinBirthBudget(state)) {
            log.warn("birth budget for this hour is exhausted; skipping the materialised scan");
            return 0;
        }

        for (const model of TRIGGER_ELIGIBLE_MODELS) {
            const spec = (SPECS as Record<string, ModelSpec>)[model]!;
            // `createdAt` is ours, not `__meta.createdAt`, because the latter is second-granular
            // with inclusive bounds and would re-emit the boundary on every scan.
            const constraint: Constraint | undefined = watermark
                ? {
                      operator: "date_range",
                      field: fieldPath(spec, "createdAt"),
                      from: watermark,
                      to: nowIso(new Date(Date.now() + 60_000)),
                  }
                : undefined;

            let candidates: Stored<Record<string, unknown>>[];
            try {
                candidates = await this.deps.things.search<Record<string, unknown>>(spec, constraint, 100);
            } catch (error) {
                log.error("materialised scan failed", { model, error: describeError(error) });
                continue;
            }

            for (const thing of candidates) {
                const createdAt = String(thing.data["createdAt"] ?? "");
                if (seen.has(thing.docRef)) continue;
                if (watermark && createdAt && createdAt < watermark) continue;

                // Never birth from a Thing whose creating Conversation is still running: that is
                // what stops the Runtime feeding on its own output part-way through a chain.
                const creator = String(thing.data["createdByConversationId"] ?? "");
                if (creator && (await this.isConversationRunning(creator))) continue;

                for (const assistant of triggered) {
                    const matches = (assistant.data.triggers ?? []).some(
                        (trigger) =>
                            trigger.kind === "thing-materialised" &&
                            (trigger.modelFilter ?? "") === model,
                    );
                    if (!matches) continue;

                    if (await this.conversationExistsFor(assistant.data.key ?? "", thing.thingId)) {
                        continue;
                    }
                    if (!this.withinBirthBudget(state)) break;

                    await this.deps.birth({
                        assistant,
                        subjectThingId: thing.thingId,
                        subjectModel: model,
                        title: `${assistant.data.name ?? assistant.data.key}: ${model} ${thing.thingId.slice(0, 8)}`,
                        prompt: [
                            `A new ${model} has appeared in the ThingStore.`,
                            ``,
                            `ThingID: \`${thing.thingId}\``,
                            ``,
                            `Deal with it according to your instructions.`,
                        ].join("\n"),
                        idempotencyKey: `birth:${assistant.data.key}:${thing.thingId}`,
                    });
                    births += 1;
                    state.data.birthsThisHour = (state.data.birthsThisHour ?? 0) + 1;
                }

                if (createdAt > newestSeen) {
                    newestSeen = createdAt;
                    boundaryDocRefs.length = 0;
                    boundaryDocRefs.push(thing.docRef);
                } else if (createdAt === newestSeen) {
                    boundaryDocRefs.push(thing.docRef);
                }
            }
        }

        if (newestSeen && newestSeen !== watermark) {
            state.data.watermark = newestSeen;
            state.data.watermarkDocRefs = boundaryDocRefs.map((docRef) => ({ docRef }));
            await this.saveState(state);
        }
        return births;
    }

    // ---------------------------------------------------------------- scan 2: answered

    /**
     * The answer is consumed on the **Conversation**, not on the OpenQuestion.
     *
     * Stamping the question would give it a second Runtime write, at the worst possible moment —
     * the User may still be editing the record they just saved. Continuing clears `waitingFor`,
     * so the Conversation stops matching this scan, and the question is never touched twice.
     */
    private async scanAnswered(): Promise<number> {
        const waiting = await this.deps.things.search<Conversation>(
            SPECS.Conversation_DM,
            and(
                eq(fieldPath(SPECS.Conversation_DM, "status"), "waiting"),
                eq(fieldPath(SPECS.Conversation_DM, "waitingFor"), "user"),
                not(unset(fieldPath(SPECS.Conversation_DM, "currentQuestionId"))),
            ),
            100,
        );

        let continued = 0;
        for (const conversation of waiting) {
            const questionId = conversation.data.currentQuestionId;
            if (!questionId) continue;
            let question: Stored<OpenQuestion>;
            try {
                question = await this.deps.things.get<OpenQuestion>(
                    SPECS.OpenQuestion_DM,
                    `OpenQuestion_DM/${questionId}`,
                );
            } catch (error) {
                log.warn("open question could not be read", {
                    questionId,
                    error: describeError(error),
                });
                continue;
            }
            if (!question.data.answeredAt) continue;

            appendEntry(conversation.data, {
                role: "user",
                kind: "answer",
                text: renderAnswer(question.data),
            });
            conversation.data.waitingFor = "";
            conversation.data.currentQuestionId = "";
            conversation.data.status = "running";
            await this.deps.things.update(
                SPECS.Conversation_DM,
                conversation.docRef,
                conversation.data as Record<string, unknown>,
            );
            await this.runTurn(conversation.docRef);
            continued += 1;
        }
        return continued;
    }

    // ---------------------------------------------------------------- scan 3: wakeAt

    private async scanWoken(): Promise<number> {
        const waiting = await this.deps.things.search<Conversation>(
            SPECS.Conversation_DM,
            and(
                eq(fieldPath(SPECS.Conversation_DM, "status"), "waiting"),
                not(unset(fieldPath(SPECS.Conversation_DM, "wakeAt"))),
            ),
            100,
        );
        const now = Date.now();
        let continued = 0;
        for (const conversation of waiting) {
            const wakeAt = parseIso(conversation.data.wakeAt);
            if (wakeAt === undefined || wakeAt > now) continue;
            appendEntry(conversation.data, {
                role: "system",
                kind: "timeout",
                text: "The time you asked to be woken at has passed. Carry on without the answer, or chase it.",
            });
            conversation.data.wakeAt = "";
            conversation.data.waitingFor = "";
            conversation.data.status = "running";
            await this.deps.things.update(
                SPECS.Conversation_DM,
                conversation.docRef,
                conversation.data as Record<string, unknown>,
            );
            await this.runTurn(conversation.docRef);
            continued += 1;
        }
        return continued;
    }

    // ---------------------------------------------------------------- scan 4: expired leases

    private async scanExpiredLeases(): Promise<number> {
        const running = await this.deps.things.search<Conversation>(
            SPECS.Conversation_DM,
            and(
                eq(fieldPath(SPECS.Conversation_DM, "status"), "running"),
                not(unset(fieldPath(SPECS.Conversation_DM, "leaseUntil"))),
            ),
            100,
        );
        const now = Date.now();
        let recovered = 0;
        for (const conversation of running) {
            const lease = parseIso(conversation.data.leaseUntil);
            if (lease === undefined || lease > now) continue;
            log.warn("recovering a conversation whose lease expired", {
                conversationId: conversation.thingId,
            });
            // The intent log is what makes this safe: any tool intent without a matching result is
            // resolved by asking the Connector, never by executing it again.
            conversation.data.leaseUntil = "";
            await this.deps.things.update(
                SPECS.Conversation_DM,
                conversation.docRef,
                conversation.data as Record<string, unknown>,
            );
            await this.runTurn(conversation.docRef);
            recovered += 1;
        }
        return recovered;
    }

    // ---------------------------------------------------------------- scan 5: result delivery

    private async scanResultDelivery(): Promise<number> {
        const finished = await this.deps.things.search<Conversation>(
            SPECS.Conversation_DM,
            and(
                eq(fieldPath(SPECS.Conversation_DM, "status"), "done"),
                setButNot(
                    fieldPath(SPECS.Conversation_DM, "parentConversationId"),
                    fieldPath(SPECS.Conversation_DM, "resultDeliveredAt"),
                ),
            ),
            100,
        );

        let delivered = 0;
        for (const child of finished) {
            const parentId = child.data.parentConversationId;
            if (!parentId) continue;
            try {
                const parent = await this.deps.things.get<Conversation>(
                    SPECS.Conversation_DM,
                    `Conversation_DM/${parentId}`,
                );

                appendEntry(parent.data, {
                    role: "user",
                    kind: "answer",
                    text: [
                        `The **${child.data.assistantKey}** assistant you called has finished.`,
                        ``,
                        child.data.result ?? "(no result)",
                    ].join("\n"),
                });

                const parentWasWaiting =
                    parent.data.status === "waiting" && parent.data.waitingFor === "assistant";
                if (parentWasWaiting) {
                    parent.data.status = "running";
                    parent.data.waitingFor = "";
                    parent.data.wakeAt = "";
                }
                await this.deps.things.update(
                    SPECS.Conversation_DM,
                    parent.docRef,
                    parent.data as Record<string, unknown>,
                );

                // A result arriving for a Conversation that has already moved on is a log line,
                // never a resurrection.
                if (parentWasWaiting) await this.runTurn(parent.docRef);
                delivered += 1;
            } catch (error) {
                log.warn("could not deliver a result to the parent conversation", {
                    child: child.thingId,
                    parentId,
                    error: describeError(error),
                });
            }

            child.data.resultDeliveredAt = nowIso();
            await this.deps.things.update(
                SPECS.Conversation_DM,
                child.docRef,
                child.data as Record<string, unknown>,
            );
        }
        return delivered;
    }

    // ---------------------------------------------------------------- scan 6: runnable

    private async scanRunnable(): Promise<number> {
        const runnable = await this.deps.things.search<Conversation>(
            SPECS.Conversation_DM,
            and(
                eq(fieldPath(SPECS.Conversation_DM, "status"), "running"),
                unset(fieldPath(SPECS.Conversation_DM, "leaseUntil")),
            ),
            50,
        );
        let turns = 0;
        for (const conversation of runnable) {
            await this.runTurn(conversation.docRef);
            turns += 1;
        }
        return turns;
    }

    // ---------------------------------------------------------------- helpers

    private async runTurn(docRef: string): Promise<void> {
        try {
            await this.deps.driver.advance(docRef);
        } catch (error) {
            log.error("advancing a conversation threw", { docRef, error: describeError(error) });
        }
    }

    private async conversationExistsFor(assistantKey: string, subjectThingId: string): Promise<boolean> {
        const found = await this.deps.things.search<Conversation>(
            SPECS.Conversation_DM,
            and(
                eq(fieldPath(SPECS.Conversation_DM, "assistantKey"), assistantKey),
                eq(fieldPath(SPECS.Conversation_DM, "subjectThingId"), subjectThingId),
            ),
            1,
        );
        return found.length > 0;
    }

    private async isConversationRunning(conversationId: string): Promise<boolean> {
        try {
            const conversation = await this.deps.things.get<Conversation>(
                SPECS.Conversation_DM,
                `Conversation_DM/${conversationId}`,
            );
            return conversation.data.status === "running" || conversation.data.status === "waiting";
        } catch {
            return false;
        }
    }

    private withinBirthBudget(state: Stored<RuntimeState>): boolean {
        const windowStart = parseIso(state.data.birthWindowStartedAt);
        const now = Date.now();
        if (windowStart === undefined || now - windowStart > 3_600_000) {
            state.data.birthWindowStartedAt = nowIso();
            state.data.birthsThisHour = 0;
            return true;
        }
        return (state.data.birthsThisHour ?? 0) < this.deps.maxBirthsPerHour;
    }

    async loadState(): Promise<Stored<RuntimeState>> {
        const found = await this.deps.things.search<RuntimeState>(
            SPECS.RuntimeState_DM,
            eq(fieldPath(SPECS.RuntimeState_DM, "singletonKey"), RUNTIME_STATE_KEY),
            2,
        );
        if (found[0]) return found[0];
        return this.deps.things.create<Record<string, unknown>>(SPECS.RuntimeState_DM, {
            singletonKey: RUNTIME_STATE_KEY,
            paused: false,
            birthsThisHour: 0,
            birthWindowStartedAt: nowIso(),
            idempotencyKey: `runtime-state:${RUNTIME_STATE_KEY}`,
        }) as Promise<Stored<RuntimeState>>;
    }

    private async saveState(state: Stored<RuntimeState>): Promise<void> {
        await this.deps.things.update(
            SPECS.RuntimeState_DM,
            state.docRef,
            state.data as Record<string, unknown>,
        );
    }

    /**
     * The heartbeat is what makes silence visible.
     *
     * The terminal failure tier raises an Open Question so nothing ends quietly — but that
     * escalation shares fate with the failures it reports: if the ThingStore is unreachable or
     * the scan loop has thrown, the escalation is itself the operation that is failing, and the
     * only symptom is that nothing happens. A stale heartbeat turns that into a visible state,
     * which is why a scan that throws must deliberately leave it untouched.
     */
    private async stampHeartbeat(state: Stored<RuntimeState>): Promise<void> {
        state.data.heartbeatAt = nowIso();
        await this.saveState(state);
    }
}

export function renderAnswer(question: OpenQuestion): string {
    const parts: string[] = [`The User answered your question:`, ``];
    if (question.confirmed !== undefined && question.kind === "confirm") {
        parts.push(`**${question.confirmed ? "Yes" : "No"}**`);
    }
    if (question.choice) parts.push(`Chose: **${question.choice}**`);
    if (question.text) parts.push(question.text);
    if (parts.length === 2) parts.push("(no further detail)");
    return parts.join("\n");
}

export { isTriggerEligible };
export type { ThingModel };
