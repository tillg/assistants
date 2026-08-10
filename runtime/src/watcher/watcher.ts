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
    byCreatedAt,
    eq,
    nowIso,
    not,
    or,
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

/** The store refuses a `pageSize` above 100, so this is a ceiling and not a preference. */
const PAGE_SIZE = 100;

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
        const enabledKeys = new Set(assistants.map((assistant) => assistant.data.key ?? ""));

        // Conversations already advanced in this pass, so scan 6 does not take a second Turn on
        // the same one.
        const handled = new Set<string>();

        // Scan 1 — Things that have materialised
        report.births += await this.scanMaterialised(state, assistants);
        // Scan 2 — the User has answered
        report.continuations += await this.scanAnswered(handled);
        // Scan 3 — wakeAt has passed
        report.continuations += await this.scanWoken(handled);
        // Scan 4 — a lease has expired: the Runtime died mid-Turn
        report.continuations += await this.scanExpiredLeases(handled);
        // Scan 5 — a child has finished and its parent has not been told
        report.continuations += await this.scanResultDelivery(handled);
        // Scan 6 — running Conversations that simply need their next Turn
        report.continuations += await this.scanRunnable(handled, enabledKeys);

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

        // The watermark may only pass a **contiguous run of decided Things**, which is stronger
        // than "a Thing that reached a decision" and is what the two losses had in common.
        //
        //   newestDecided — the newest Thing this pass actually decided.
        //   ceiling       — what the watermark may not pass: the lowest per-Model frontier, where a
        //                   Model contributes one only if it might still be hiding an undecided
        //                   Thing at or after that point. Two ways that happens: it froze on one,
        //                   or its page was full so there is more behind it that this pass never
        //                   saw. A Model whose page was short and wholly decided contributes
        //                   nothing — otherwise one quiet Model would pin the watermark for ever.
        let newestDecided = watermark ?? "";
        let ceiling: string | undefined;
        const decidedAt = new Map<string, string[]>();
        const lowest = (current: string | undefined, candidate: string) =>
            current === undefined || candidate < current ? candidate : current;

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
                // Ordered oldest-first, which is what makes "a contiguous run" meaningful: without
                // it the page is an arbitrary window and its maximum `createdAt` says nothing about
                // what lies between the watermark and there.
                candidates = await this.deps.things.search<Record<string, unknown>>(
                    spec,
                    constraint,
                    PAGE_SIZE,
                    byCreatedAt(spec, "ASC"),
                );
            } catch (error) {
                log.error("materialised scan failed", { model, error: describeError(error) });
                // A Model whose query failed decided nothing, so it may not let the watermark move.
                ceiling = lowest(ceiling, watermark ?? "");
                continue;
            }

            /** The newest Thing in this Model with everything at or before it decided. */
            let frontier: string | undefined;
            let frozen = false;
            const freeze = () => {
                if (frozen) return;
                frozen = true;
                if (frontier === undefined) frontier = watermark ?? "";
            };

            for (const thing of candidates) {
                const createdAt = String(thing.data["createdAt"] ?? "");
                if (seen.has(thing.docRef)) continue;
                if (watermark && createdAt && createdAt < watermark) continue;

                // Never birth from a Thing whose creating Conversation is still running: that is
                // what stops the Runtime feeding on its own output part-way through a chain.
                const creator = String(thing.data["createdByConversationId"] ?? "");
                if (creator && (await this.isConversationRunning(creator))) {
                    freeze();
                    continue;
                }

                let decided = true;
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
                    if (!this.withinBirthBudget(state)) {
                        decided = false;
                        break;
                    }

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

                // The budget ran out on this Thing: same rule as a running creator.
                if (!decided) {
                    freeze();
                    continue;
                }
                if (createdAt > newestDecided) newestDecided = createdAt;
                decidedAt.set(createdAt, [...(decidedAt.get(createdAt) ?? []), thing.docRef]);
                // A Thing after the freeze point is still birthed — birth is exactly-once by query,
                // so that is safe, and it keeps latency low. It just may not move the frontier.
                if (!frozen && (frontier === undefined || createdAt > frontier)) frontier = createdAt;
            }

            if (frozen) {
                ceiling = lowest(ceiling, frontier ?? watermark ?? "");
            } else if (candidates.length >= PAGE_SIZE && frontier !== undefined) {
                // A full page means there is more behind it that this pass never saw. Cap the
                // watermark at the newest row the page did contain; the rest stays in front of it
                // and is picked up on the next scan.
                ceiling = lowest(ceiling, frontier);
            }
        }

        const newestSeen =
            ceiling !== undefined && ceiling < newestDecided ? ceiling : newestDecided;
        // Only the rows sitting exactly ON the new watermark: `date_range.from` is inclusive, so
        // those come back on the next scan and this is what stops them being birthed twice.
        const boundaryDocRefs = decidedAt.get(newestSeen) ?? [];

        if (newestSeen && newestSeen !== watermark) {
            state.data.watermark = newestSeen;
            state.data.watermarkDocRefs = boundaryDocRefs.map((docRef) => ({ docRef }));
            // Same hazard `stampHeartbeat` guards against, and it was unguarded here: this writes
            // a copy read at the top of a pass that takes seconds, so a `just pause` issued in
            // between was silently reverted. Measured: 1 revert in 44 attempts.
            await this.savePreservingHumanFields(state);
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
    private async scanAnswered(handled: Set<string>): Promise<number> {
        // `waitingFor` is "user" for ui.askUser and "tool" for every Manual Connector — and a
        // Manual Connector is answered through exactly the same Open Question. Filtering on
        // "user" alone left every email.send / bank.sendMoney / document.requestText suspended
        // forever: no other scan can reach a waiting Conversation either, so it was terminal and
        // silent, with the heartbeat still green.
        const waiting = await this.deps.things.search<Conversation>(
            SPECS.Conversation_DM,
            and(
                eq(fieldPath(SPECS.Conversation_DM, "status"), "waiting"),
                or(
                    eq(fieldPath(SPECS.Conversation_DM, "waitingFor"), "user"),
                    eq(fieldPath(SPECS.Conversation_DM, "waitingFor"), "tool"),
                ),
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
                // The question is gone — most likely deleted by hand. The Conversation is waiting
                // on something that no longer exists, so without this it would wait forever.
                log.warn("the open question a conversation was waiting on has gone", {
                    questionId,
                    conversationId: conversation.thingId,
                    error: describeError(error),
                });
                appendEntry(conversation.data, {
                    role: "system",
                    kind: "error",
                    text: `The question you were waiting on (\`${questionId}\`) no longer exists. It was probably deleted. Ask again if you still need an answer.`,
                });
                conversation.data.currentQuestionId = "";
                conversation.data.waitingFor = "";
                conversation.data.status = "running";
                await this.deps.things.update(
                    SPECS.Conversation_DM,
                    conversation.docRef,
                    conversation.data as Record<string, unknown>,
                );
                handled.add(conversation.docRef);
                await this.runTurn(conversation.docRef);
                continued += 1;
                continue;
            }
            // NOT `answeredAt` alone. Nothing stamps it — it is a plain editable DateTime on the
            // form — so a User who types an answer, sets Confirmed and presses Save has, from
            // their point of view, answered; and the Conversation would wait forever. Any answer
            // field being filled in means answered. `answeredAt` stays as the record of *when*,
            // for anyone who fills it in.
            if (!isAnswered(question.data)) continue;

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
            handled.add(conversation.docRef);
            await this.runTurn(conversation.docRef);
            continued += 1;
        }
        return continued;
    }

    // ---------------------------------------------------------------- scan 3: wakeAt

    private async scanWoken(handled: Set<string>): Promise<number> {
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
            handled.add(conversation.docRef);
            await this.runTurn(conversation.docRef);
            continued += 1;
        }
        return continued;
    }

    // ---------------------------------------------------------------- scan 4: expired leases

    private async scanExpiredLeases(handled: Set<string>): Promise<number> {
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
            handled.add(conversation.docRef);
            await this.runTurn(conversation.docRef);
            recovered += 1;
        }
        return recovered;
    }

    // ---------------------------------------------------------------- scan 5: result delivery

    private async scanResultDelivery(handled: Set<string>): Promise<number> {
        // `done` OR `failed`: a child that gave up still owes its caller an answer. Without this a
        // parent waits on `assistant` forever with nothing anywhere saying why.
        const finished = await this.deps.things.search<Conversation>(
            SPECS.Conversation_DM,
            and(
                or(
                    eq(fieldPath(SPECS.Conversation_DM, "status"), "done"),
                    eq(fieldPath(SPECS.Conversation_DM, "status"), "failed"),
                ),
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

                const failed = child.data.status === "failed";
                appendEntry(parent.data, {
                    role: "user",
                    kind: "answer",
                    text: failed
                        ? [
                              `The **${child.data.assistantKey}** assistant you called did not finish.`,
                              ``,
                              child.data.lastError ?? "(no reason recorded)",
                              ``,
                              `Decide what to do without it.`,
                          ].join("\n")
                        : [
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

                // Stamped only after the parent write succeeded. Stamping unconditionally would
                // mark a failed delivery as delivered, and the scan would never retry it — the
                // parent then waits on `assistant` forever with one warn line as the only trace.
                child.data.resultDeliveredAt = nowIso();
                await this.deps.things.update(
                    SPECS.Conversation_DM,
                    child.docRef,
                    child.data as Record<string, unknown>,
                );

                // A result arriving for a Conversation that has already moved on is a log line,
                // never a resurrection.
                if (parentWasWaiting) {
                    handled.add(parent.docRef);
                    await this.runTurn(parent.docRef);
                }
                delivered += 1;
            } catch (error) {
                log.warn("could not deliver a result to the parent conversation; will retry", {
                    child: child.thingId,
                    parentId,
                    error: describeError(error),
                });
            }
        }
        return delivered;
    }

    // ---------------------------------------------------------------- scan 6: runnable

    private async scanRunnable(handled: Set<string>, enabledKeys: Set<string>): Promise<number> {
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
            // Scans 2-5 leave a Conversation `running` with no lease and advance it themselves.
            // Without this guard scan 6 finds the same Conversation in the same pass and takes a
            // second Turn — two LLM calls per scan, and maxTurns burning at twice the stated rate.
            if (handled.has(conversation.docRef)) continue;
            // A disabled Assistant's Conversation stays `running` forever; advancing it every two
            // seconds just churns updatedAt and makes the log look busy.
            if (!enabledKeys.has(conversation.data.assistantKey ?? "")) continue;
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
        // Seeded with a watermark, exactly as `just bootstrap` does. The runtime container starts
        // before bootstrap runs and therefore always wins this race; without the watermark the
        // first materialised scan would have no date bound and birth a Conversation for every
        // pre-existing Thing in the store.
        return this.deps.things.create<Record<string, unknown>>(SPECS.RuntimeState_DM, {
            singletonKey: RUNTIME_STATE_KEY,
            paused: false,
            birthsThisHour: 0,
            birthWindowStartedAt: nowIso(),
            watermark: nowIso(),
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
     *
     * **Re-reads before writing.** `scan()` loads the state at the top of a pass that takes
     * seconds; writing the whole in-memory copy back at the end would silently undo a `just
     * pause` issued in between — the global kill switch, lost, with nothing saying so. A12 has no
     * compare-and-swap to lean on, so the least-bad thing available is to re-read and carry
     * forward the fields a human owns.
     */
    private async stampHeartbeat(state: Stored<RuntimeState>): Promise<void> {
        state.data.heartbeatAt = nowIso();
        await this.savePreservingHumanFields(state);
    }

    /**
     * Write the RuntimeState without trampling what another writer has done.
     *
     * `paused` is the global kill switch and the User may flip it at any moment, including
     * halfway through a scan. A12 has no compare-and-swap, so the least-bad thing available is
     * to re-read immediately before writing and carry those fields forward. If it cannot be
     * re-read, do not write at all — a stale heartbeat is the honest outcome and the health
     * probe reports it.
     *
     * `watermark` needs the same care for a different reason: `just demo-data` moves it forward so
     * the demo set lands as history rather than as a work queue, and a scan holding an older copy
     * used to put it straight back — re-queueing the entire household. Carried forward only when
     * the fresh one is **ahead**, so this cannot mask the scan's own progress; a deliberate
     * rollback to reprocess would be overridden, which is the trade and is why it is one-directional.
     *
     * The remaining window cannot be closed without compare-and-swap: another writer landing
     * between this re-read and the write still loses. Recorded rather than papered over.
     */
    private async savePreservingHumanFields(state: Stored<RuntimeState>): Promise<void> {
        let fresh: Stored<RuntimeState>;
        try {
            fresh = await this.deps.things.get<RuntimeState>(SPECS.RuntimeState_DM, state.docRef);
        } catch {
            return;
        }
        const paused = fresh.data.paused;
        const ours = state.data.watermark ?? "";
        const theirs = fresh.data.watermark ?? "";
        const watermarkIsTheirs = theirs > ours;

        await this.saveState({
            ...state,
            data: {
                ...state.data,
                paused,
                ...(watermarkIsTheirs
                    ? { watermark: theirs, watermarkDocRefs: fresh.data.watermarkDocRefs }
                    : {}),
            },
        });
        state.data.paused = paused ?? state.data.paused;
        if (watermarkIsTheirs) {
            state.data.watermark = theirs;
            state.data.watermarkDocRefs = fresh.data.watermarkDocRefs;
        }
    }
}

/**
 * Has the User answered?
 *
 * Deliberately generous: any of the answer fields carrying a value counts. The alternative —
 * requiring the timestamp — meant the primary interaction of the whole product silently did
 * nothing, which is the failure ADR-0015 exists to forbid.
 */
export function isAnswered(question: OpenQuestion): boolean {
    if (question.answeredAt) return true;
    if (typeof question.text === "string" && question.text.trim() !== "") return true;
    if (typeof question.choice === "string" && question.choice.trim() !== "") return true;
    return question.confirmed === true || question.confirmed === false;
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
