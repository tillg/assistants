/**
 * The trigger watcher.
 *
 * This is the component none of the three agent systems surveyed in AGENTIC_LOOP.md has, because
 * all three are born from a human typing. Ours has to notice work by itself, so it scans the
 * ThingStore — which is also the only Authority for pending work (ADR-0004), so there is nothing
 * else it *could* scan.
 *
 * Seven scans. Birth is exactly-once by query rather than by timing: a Thing does not birth a
 * Conversation if one already exists for `(assistantKey, subjectThingId)` — and a Schedule, which has
 * no subject Thing to ask about, does not birth one if one already exists for
 * `(assistantKey, scheduledFor)` (ADR-0016).
 */

import { log, describeError } from "../log.js";
import {
    and,
    byCreatedAt,
    byField,
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
    type Operation,
    type RuntimeState,
    type Stored,
    type ThingModel,
} from "../domain/types.js";
import { appendEntry, LoopDriver } from "../loop/advance.js";
import { describeInstant, latestDueInstantBefore } from "./schedule.js";

export interface WatcherDeps {
    things: ThingRepository;
    driver: LoopDriver;
    maxBirthsPerHour: number;
    /** The timezone every `cron` is read in (ADR-0016). */
    scheduleTimezone: string;
    /**
     * Go and look in the letterbox (ADR-0024). Absent when no mailbox is configured, which is the
     * default and not an error.
     *
     * A thunk rather than the ingest itself: this file has no business knowing what IMAP is, and
     * the one thing it needs from the mailbox — *did anything arrive?* — is the same shape as the
     * question it asks the store seven times already. It returns how many Documents it created, so
     * the scan can say so; everything else it learned it has already logged.
     */
    pollMailbox?: () => Promise<number>;
    /** How often {@link pollMailbox} is worth calling. Ignored when there is no mailbox. */
    mailPollIntervalMs?: number;
    /** Create a Conversation for an Assistant, about a Thing. Returns its docRef. */
    birth(input: {
        assistant: Stored<Assistant>;
        subjectThingId?: string;
        subjectModel?: string;
        /** The due instant a scheduled Conversation serves. Exactly one of this and the subject is set. */
        scheduledFor?: string;
        prompt: string;
        title: string;
        parentConversationId?: string;
        idempotencyKey: string;
    }): Promise<string>;
}

export const RUNTIME_STATE_KEY = "the-one";

/** The store refuses a `pageSize` above 100, so this is a ceiling and not a preference. */
const PAGE_SIZE = 100;

/**
 * How long a Model's frontier may stay pinned at one point before it is worth saying so.
 *
 * Freezing is correct and routine: it is how a Thing created mid-Conversation waits for its creator
 * to finish. The scan runs every two seconds, so warning whenever a frontier is frozen — or on two
 * consecutive frozen scans — would warn on every healthy chain in the system, and an operator who
 * is warned about healthy behaviour stops reading the warnings. This is long enough that only a
 * creator that has genuinely stopped reaches it.
 */
const FROZEN_FRONTIER_WARN_AFTER_MS = 5 * 60_000;

/**
 * How many pages of waiting Conversations one answered scan will walk before it stops for this pass.
 *
 * There has to be a number here, and both directions of getting it wrong are outages. Without a
 * bound, a store holding tens of thousands of waiting Conversations turns one pass into a walk of
 * all of them, every two seconds, and a scan that never returns is its own outage — the other six
 * scans are behind it. With the bound but without the cursor that goes with it, the pass stops in
 * the same place for ever and everything behind that place is lost, which is precisely the failure
 * this constant exists inside the fix for. Three pages is 300 Conversations and 300 question reads
 * per pass: enough that no real household ever needs a second pass, small enough that a store which
 * has somehow accumulated ten thousand waiting Conversations is covered in 34 passes — a little over
 * a minute — rather than by one pass that never ends.
 */
const ANSWERED_SCAN_MAX_PAGES = 3;

/**
 * How long a Schedule may be held by an unfinished run before it is worth saying so.
 *
 * Longer than the frontier warning, because a held schedule is more ordinary and less urgent: the
 * question holding it is already in the User's inbox, and answering it is the fix. Half an hour is
 * long enough that an approval answered over a cup of coffee never produces a line.
 */
const STALLED_SCHEDULE_WARN_AFTER_MS = 30 * 60_000;

export interface ScanReport {
    births: number;
    continuations: number;
    paused: boolean;
    errors: number;
    /**
     * Documents created from the letterbox this pass — counted apart from `births` because they are
     * a different kind of thing. A birth is a Conversation; this is a Document, which may or may not
     * become one. Folding it into `births` would make the log say a Conversation started when what
     * happened is that post arrived.
     */
    ingested: number;
}

export class Watcher {
    constructor(private readonly deps: WatcherDeps) {}

    /**
     * Per Model: the point its frontier froze at, when it first froze there, and whether that has
     * been reported. In memory only — a restart re-arms the warning, which is the right way round:
     * a stall that survives a restart is worth hearing about again.
     */
    private readonly frozenFrontiers = new Map<
        string,
        { at: string; since: number; warned: boolean }
    >();

    /** Assistants whose `cron` could not be read, so the complaint is made once per process. */
    private readonly badCrons = new Set<string>();

    /**
     * Where the answered scan stopped sweeping, as a `createdAt` — `undefined` means "at the
     * beginning". See {@link scanAnswered} for what it is for and why it is only in memory.
     */
    private answeredCursor: string | undefined;

    /**
     * The sweep cursor for scan 5 (result delivery), the twin of {@link answeredCursor}. Result
     * delivery needs it more than the answered scan does: its rows are machine-generated and some
     * can never be delivered, so an unordered window let them shadow deliverable ones for ever.
     */
    private resultDeliveryCursor: string | undefined;

    /** Per Assistant: the slot its schedule is held at, and whether that has been reported. */
    private readonly stalledSlots = new Map<
        string,
        { scheduledFor: string; since: number; warned: boolean }
    >();

    /**
     * Has an empty or unreadable catalogue already been reported? In memory, so a restart
     * re-announces it, and so the recovery line is written exactly once when one appears.
     */
    private catalogueMissing = false;

    /**
     * When the letterbox was last opened. In memory, so a restart polls at once — which is right:
     * a Runtime that has just come up is exactly when post is most likely to be waiting.
     */
    private mailboxPolledAt: number | undefined;

    /** Is the mailbox currently unreachable? So the complaint is made once per outage. */
    private mailboxFailing = false;

    /** One pass. Returns what it did, so the caller can log and stamp the heartbeat. */
    async scan(): Promise<ScanReport> {
        const report: ScanReport = {
            births: 0,
            continuations: 0,
            paused: false,
            errors: 0,
            ingested: 0,
        };

        // Before anything else, including the heartbeat: every Turn this pass could start would
        // throw on the catalogue read anyway (ADR-0019), so scanning would produce one identical
        // error per Conversation per two seconds and a green heartbeat over a system doing nothing.
        if (!(await this.catalogueIsThere())) {
            report.errors += 1;
            return report;
        }

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

        // Scan 0 — the letterbox. First, and deliberately: it is the only scan that does not look
        // in the store, and anything it creates is a Document that scan 1 can then find in the very
        // same pass. Putting it last would cost every forwarded invoice a whole extra scan interval
        // before its Conversation was born.
        //
        // It is after the pause check and after the catalogue check, and both are right: `just
        // pause` should stop post arriving as surely as it stops Turns, and the ingest reads the
        // `email.receive` Operation Thing to see whether it has been switched off.
        report.ingested += await this.scanMailbox();

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
        // Scan 7 — a Schedule whose due instant has passed and has not been served
        report.births += await this.scanScheduled(state, assistants);

        await this.stampHeartbeat(state);
        return report;
    }

    /**
     * Is there a catalogue to scan against?
     *
     * The Runtime does not exit when there is not: `just up` before `just bootstrap` is a normal
     * ordering rather than an error, and a container restarting every two seconds is harder to read
     * than one that is up and saying why. So it stays inspectable, does no work, and — by leaving
     * the heartbeat unstamped — reports unhealthy, which is the signal an operator gets without
     * reading the log at all.
     *
     * Said **once per outage** rather than once per scan, for the reason {@link noteBadCron} and
     * {@link noteFrozenFrontier} both give: an operator flooded with a line every two seconds stops
     * reading them. The heartbeat is the continuous signal; this is the explanation. The recovery
     * is logged at the transition for the same reason in reverse — "it seems to be working now"
     * becomes evidence.
     */
    private async catalogueIsThere(): Promise<boolean> {
        let operations: number;
        try {
            operations = (
                await this.deps.things.search<Operation>(SPECS.Operation_DM, undefined, PAGE_SIZE)
            ).length;
        } catch (error) {
            this.noteMissingCatalogue(`the Operation catalogue could not be read: ${describeError(error)}`);
            return false;
        }
        if (operations === 0) {
            this.noteMissingCatalogue("the Operation catalogue is empty");
            return false;
        }
        if (this.catalogueMissing) {
            this.catalogueMissing = false;
            log.info(`catalogue found: ${operations} Operations; scanning resumed`, { operations });
        }
        return true;
    }

    // ---------------------------------------------------------------- scan 0: the letterbox

    /**
     * Go and look in the letterbox, but not on every pass (ADR-0024).
     *
     * `SCAN_INTERVAL_MS` is two seconds and an IMAP login every two seconds is abusive enough that
     * several providers rate-limit or lock the account for it. So this keeps its own clock and
     * returns immediately when it is not due — household post is not latency-sensitive, and a
     * minute is invisible against a forward somebody sent from a phone.
     *
     * The clock is in memory, so a restart polls at once. That is the right way round: a Runtime
     * that has just come up is exactly when there is most likely to be post waiting.
     *
     * **Nothing escapes this method.** A mailbox that is unreachable, refusing the password or
     * serving garbage must not take the other seven scans with it — those are the ones that keep
     * already-running Conversations moving, and they have nothing to do with email. There is no
     * backoff state and no circuit breaker: the next poll is a minute away, which *is* the backoff.
     */
    private async scanMailbox(): Promise<number> {
        const poll = this.deps.pollMailbox;
        if (!poll) return 0;

        const interval = this.deps.mailPollIntervalMs ?? 60_000;
        const now = Date.now();
        if (this.mailboxPolledAt !== undefined && now - this.mailboxPolledAt < interval) return 0;
        // Stamped before the call rather than after, so a poll that takes longer than the interval
        // cannot queue a second one up behind it the moment it returns.
        this.mailboxPolledAt = now;

        try {
            const created = await poll();
            if (this.mailboxFailing) {
                this.mailboxFailing = false;
                log.info("the letterbox is reachable again");
            }
            return created;
        } catch (error) {
            // Once per outage, for the reason every other note in this file gives: a line a minute
            // about a mailbox that is down is a line a minute nobody reads.
            if (!this.mailboxFailing) {
                this.mailboxFailing = true;
                log.error("could not read the letterbox", { error: describeError(error) });
            }
            return 0;
        }
    }

    private noteMissingCatalogue(reason: string): void {
        if (this.catalogueMissing) return;
        this.catalogueMissing = true;
        log.error(
            `not scanning: ${reason}, so no Assistant can be offered anything and every Turn would ` +
                `fail. Run \`just bootstrap\`; scanning resumes by itself once it has.`,
            { reason },
        );
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

        // A Thing the User created in the web application carries no `createdAt`: the four machine
        // fields are on no form and A12's form engine has no save hook that could stamp one. The
        // scan's `date_range` cannot match an absent value, so such a Thing would never be seen —
        // the User's own way of starting work, doing nothing at all.
        //
        // `createdAt` is the Runtime's field, so the Runtime fills it in. Stamping rather than
        // special-casing the query keeps one code path for birth and one meaning for the watermark;
        // the Thing is picked up by the very next scan through the ordinary route.
        await this.stampMissingCreatedAt();

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
            /** What froze it, kept for the warning: the first one is the one holding the line. */
            let blockedBy: { docRef: string; reason: string } | undefined;
            const freeze = (docRef: string, reason: string) => {
                if (frozen) return;
                frozen = true;
                blockedBy = { docRef, reason };
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
                    freeze(thing.docRef, `its creating Conversation ${creator} is still running`);
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
                    freeze(thing.docRef, "the birth budget for this hour ran out");
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
                this.noteFrozenFrontier(model, frontier ?? watermark ?? "", blockedBy);
            } else {
                // Moving again — so a later stall at a new point is worth reporting afresh.
                this.frozenFrontiers.delete(model);
                if (candidates.length >= PAGE_SIZE && frontier !== undefined) {
                    // A full page means there is more behind it that this pass never saw. Cap the
                    // watermark at the newest row the page did contain; the rest stays in front of
                    // it and is picked up on the next scan.
                    ceiling = lowest(ceiling, frontier);
                }
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

    /**
     * Say once when a Model's frontier has been pinned at one point for long enough to be a stall.
     *
     * Nothing is lost while it is pinned and nothing here tries to unpin it — the fix is whatever
     * unblocks the Conversation, and that is a decision for an operator. This only turns a silent
     * stall into something an operator can see, which is the difference between a system that is
     * waiting and a system that has stopped.
     */
    private noteFrozenFrontier(
        model: string,
        at: string,
        blockedBy: { docRef: string; reason: string } | undefined,
    ): void {
        const previous = this.frozenFrontiers.get(model);
        if (previous?.at !== at) {
            this.frozenFrontiers.set(model, { at, since: Date.now(), warned: false });
            return;
        }
        const frozenForMs = Date.now() - previous.since;
        if (previous.warned || frozenForMs < FROZEN_FRONTIER_WARN_AFTER_MS) return;
        previous.warned = true;
        log.warn(
            `the watermark for ${model} has been pinned at one point for ${Math.round(frozenForMs / 60_000)} minutes; ` +
                `nothing is lost, but nothing behind it will be birthed until it moves`,
            { model, frontier: at, frozenForMs, blockedBy: blockedBy?.docRef, reason: blockedBy?.reason },
        );
    }

    /**
     * Give a Thing with no `createdAt` one, so the materialised scan can see it.
     *
     * Only the User's own writes land here — everything the Runtime creates goes through
     * `ThingRepository.create`, which stamps it. The stamp is "when the Runtime first noticed",
     * which is the closest honest thing available: `__meta.createdAt` is what A12 recorded, but it
     * is second-granular with inclusive range bounds, which is the reason this project keeps its own
     * field in the first place.
     *
     * Deliberately not the same thing as birthing it here: this only fills the field in, and the
     * next scan births it through exactly the same path as everything else.
     */
    private async stampMissingCreatedAt(): Promise<void> {
        for (const model of TRIGGER_ELIGIBLE_MODELS) {
            const spec = (SPECS as Record<string, ModelSpec>)[model]!;
            let orphans: Stored<Record<string, unknown>>[];
            try {
                orphans = await this.deps.things.search<Record<string, unknown>>(
                    spec,
                    unset(fieldPath(spec, "createdAt")),
                    PAGE_SIZE,
                );
            } catch (error) {
                log.error("could not look for Things with no createdAt", {
                    model,
                    error: describeError(error),
                });
                continue;
            }
            for (const thing of orphans) {
                try {
                    // ONLY the field being filled in. `update` merges what it is given over the
                    // current document, so passing the snapshot this search took would write every
                    // field of it back — reverting whatever the User saved between the read and the
                    // write. The window is two seconds wide and a Party is the most ordinary thing
                    // for a human to create and then correct, so that is not a theoretical race:
                    // it reverted a city in the very next `just test`.
                    await this.deps.things.update(spec, thing.docRef, { createdAt: nowIso() });
                    log.info("stamped createdAt on a Thing that had none", {
                        model,
                        thingId: thing.thingId,
                    });
                } catch (error) {
                    // Left for the next pass rather than retried here: a failure that repeats is
                    // visible in the log, and a Thing without the field is simply not yet seen.
                    log.warn("could not stamp createdAt", {
                        model,
                        thingId: thing.thingId,
                        error: describeError(error),
                    });
                }
            }
        }
    }

    // ---------------------------------------------------------------- scan 2: answered

    /**
     * The answer is consumed on the **Conversation**, not on the OpenQuestion.
     *
     * Stamping the question would give it a second Runtime write, at the worst possible moment —
     * the User may still be editing the record they just saved. Continuing clears `waitingFor`,
     * so the Conversation stops matching this scan, and the question is never touched twice.
     *
     * **It sweeps; it does not look at whatever hundred the store hands back.** For a long time this
     * scan read one unordered page of 100 waiting Conversations, iterated exactly those and returned.
     * That is fine while a household has a dozen questions open and silently terminal once it has
     * more than a hundred: which 100 came back was an arbitrary window, nothing favoured the rows
     * that had just been answered, and there was neither a second page nor a position to carry
     * forward. Measured on a live stack with 501 waiting Conversations — an Accountant sat with
     * `waitingFor = "user"` and a `currentQuestionId` pointing at a question the User had answered
     * ten minutes earlier, the invoice slice timed out waiting for an approval that could therefore
     * never be raised, and every health check stayed green throughout. The comment above about
     * widening the `waitingFor` filter describes fixing that same shape of failure once already; the
     * cap put it straight back at a hundred rows instead of at one Connector.
     *
     * So: ordered oldest-first by `createdAt`, bounded below by a cursor, and walked page by page.
     * Raising the constant was the tempting fix and is not one — it moves the cliff from 100 to
     * 1000 and leaves it there. Three properties are what matter, and each costs something:
     *
     *   - **Bounded per pass.** {@link ANSWERED_SCAN_MAX_PAGES} pages, because the other six scans
     *     are queued behind this one and a pass that walks ten thousand Conversations every two
     *     seconds is its own outage.
     *   - **Eventual coverage.** When the pages run out the cursor is kept, so the next pass carries
     *     on from where this one stopped rather than re-reading the same first page; when a page
     *     comes back short the sweep has reached the end and the cursor returns to the beginning.
     *     A Conversation is therefore reached within `ceil(waiting / 300)` passes however many
     *     others are waiting, which is the guarantee the cap did not have at any size.
     *   - **No new store field.** The cursor lives in memory, so a restart resumes from the
     *     beginning. That is the safe direction — it re-examines rows rather than skipping them —
     *     and it is the same choice the frozen-frontier and stalled-schedule notes make: a restart
     *     is allowed to cost a little duplicated reading, and is not allowed to lose a position that
     *     would have let something be missed.
     *
     * The trade the cursor cannot pay for is a `createdAt` tie: the field is second-granular, so more
     * than a page of Conversations born inside one second cannot be enumerated at all — `search`
     * takes no page number and there is no second orderable field to break the tie on. That case
     * steps past the group and says so in the log, which is described where it happens.
     */
    private async scanAnswered(handled: Set<string>): Promise<number> {
        const spec = SPECS.Conversation_DM;
        let continued = 0;
        /**
         * Where this pass starts sweeping. `undefined` is the beginning, which is where a freshly
         * started Runtime always begins.
         */
        let cursor = this.answeredCursor;
        /**
         * Every waiting Conversation this pass has already looked at. The cursor is a `date_range`
         * and `from` is inclusive, so consecutive pages overlap on the boundary second by
         * construction; this is what keeps the overlap from being counted as progress.
         */
        const examined = new Set<string>();

        for (let page = 0; page < ANSWERED_SCAN_MAX_PAGES; page += 1) {
            // `waitingFor` is "user" for ui.askUser and "tool" for every Manual Connector — and a
            // Manual Connector is answered through exactly the same Open Question. Filtering on
            // "user" alone left every email.send / bank.sendMoney / document.requestText suspended
            // forever: no other scan can reach a waiting Conversation either, so it was terminal and
            // silent, with the heartbeat still green.
            //
            // Ordered oldest-first and bounded below by the cursor, which is the whole of the fix:
            // an unordered single page is an arbitrary window, and a window is not a sweep.
            const waiting = await this.deps.things.search<Conversation>(
                spec,
                and(
                    eq(fieldPath(spec, "status"), "waiting"),
                    or(
                        eq(fieldPath(spec, "waitingFor"), "user"),
                        eq(fieldPath(spec, "waitingFor"), "tool"),
                    ),
                    not(unset(fieldPath(spec, "currentQuestionId"))),
                    ...(cursor === undefined
                        ? []
                        : [
                              {
                                  operator: "date_range",
                                  field: fieldPath(spec, "createdAt"),
                                  from: cursor,
                              } as Constraint,
                          ]),
                ),
                PAGE_SIZE,
                byCreatedAt(spec, "ASC"),
            );

            /** The newest `createdAt` this page contained: where the next page picks up. */
            let newest = cursor;
            /** Rows in this page the pass had not already examined — its progress, in other words. */
            let fresh = 0;

            for (const conversation of waiting) {
                const createdAt = conversation.data.createdAt ?? "";
                if (createdAt && (newest === undefined || createdAt > newest)) newest = createdAt;
                if (examined.has(conversation.docRef)) continue;
                examined.add(conversation.docRef);
                fresh += 1;

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
                    // Every answer carries the id of the question it answers, not only the ones that
                    // matter to something. The approval walk-back reads it, and the alternative is a
                    // scan that has to know which questions are approvals — which is the same coupling
                    // in the more fragile direction.
                    questionId,
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

            // A short page is the end of the sweep: nothing waiting exists past the newest row this
            // page contained, so the next pass starts from the beginning again. This is the only
            // place the cursor is allowed to go backwards, and it has to exist — a cursor that only
            // ever advanced would walk off the end of the data and never look at the beginning
            // again, which is the same loss as the cap with the rows in the other order.
            if (waiting.length < PAGE_SIZE) {
                this.answeredCursor = undefined;
                return continued;
            }

            if (fresh === 0) {
                // A full page in which every row had already been examined. The cursor is a second-
                // granular `createdAt`, so this means more than PAGE_SIZE waiting Conversations share
                // one second and the store cannot be asked for the rest of them: `search` offers no
                // page number, and there is no second orderable field to break the tie on. Stepping
                // one second past the group is the only way to keep the sweep moving; the honest cost
                // is that the Conversations in the tail of that group are not looked at on this
                // sweep, and the honest alternative is a scan that stops here for ever, which is the
                // failure being fixed. Said out loud, because an operator who ever sees this line has
                // a Conversation that may be answered and unreached.
                const tied = parseIso(newest);
                log.warn(
                    `more than ${PAGE_SIZE} waiting Conversations were created in the same second, so ` +
                        `some of them cannot be reached by this scan; stepping past them`,
                    { createdAt: newest, examined: examined.size },
                );
                if (tied === undefined) {
                    this.answeredCursor = undefined;
                    return continued;
                }
                cursor = nowIso(new Date(tied + 1_000));
                continue;
            }

            cursor = newest;
        }

        // Out of pages, not out of Conversations. Remember where the sweep got to, so the next pass
        // carries on from here instead of starting again at the same first page for ever — which is
        // exactly what the uncapped, unordered single page used to do, and how a Conversation whose
        // answer had been sitting in the store for ten minutes was never come back for.
        this.answeredCursor = cursor;
        return continued;
    }

    // ---------------------------------------------------------------- scan 3: wakeAt

    private async scanWoken(handled: Set<string>): Promise<number> {
        const spec = SPECS.Conversation_DM;
        // Bounded to the rows that are actually *due* (`wakeAt <= now`) and ordered earliest-first,
        // so the 100-cap holds due wake-ups rather than an arbitrary window of sleeping ones. Without
        // the bound, a page of not-yet-due rows was skipped whole while genuinely-due Conversations
        // past position 100 were never fetched and missed their deadline for ever.
        const nowStamp = nowIso();
        const waiting = await this.deps.things.search<Conversation>(
            spec,
            and(
                eq(fieldPath(spec, "status"), "waiting"),
                not(unset(fieldPath(spec, "wakeAt"))),
                {
                    operator: "date_range",
                    field: fieldPath(spec, "wakeAt"),
                    to: nowStamp,
                } as Constraint,
            ),
            100,
            byField(spec, "wakeAt", "ASC"),
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
        const spec = SPECS.Conversation_DM;
        // Bounded to the leases that have actually *expired* (`leaseUntil <= now`) and ordered
        // oldest-first, so the 100-cap is expired leases rather than an arbitrary window of running
        // Conversations — an unordered window could leave a genuinely-stuck Conversation past
        // position 100 unrecovered indefinitely.
        const nowStamp = nowIso();
        const running = await this.deps.things.search<Conversation>(
            spec,
            and(
                eq(fieldPath(spec, "status"), "running"),
                not(unset(fieldPath(spec, "leaseUntil"))),
                {
                    operator: "date_range",
                    field: fieldPath(spec, "leaseUntil"),
                    to: nowStamp,
                } as Constraint,
            ),
            100,
            byField(spec, "leaseUntil", "ASC"),
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
        const spec = SPECS.Conversation_DM;
        let delivered = 0;
        // Ordered oldest-first and swept with a cursor across passes, exactly as {@link scanAnswered}
        // — and for a sharper reason. This set is machine-generated (a fan-out fills it) and it holds
        // rows that can never leave it: a child whose parent was deleted by hand throws below, is
        // logged "will retry", and is never stamped delivered. An unordered 100-cap let a hundred
        // such stuck rows shadow every deliverable child queued behind them, so a parent waited on
        // `assistant` for ever with one warn line as the only trace. The cursor walks past the stuck
        // rows to the deliverable ones instead of returning the same arbitrary window every pass.
        let cursor = this.resultDeliveryCursor;
        /** Every finished child this pass has already looked at — see {@link scanAnswered}. */
        const examined = new Set<string>();

        for (let page = 0; page < ANSWERED_SCAN_MAX_PAGES; page += 1) {
            // `done` OR `failed`: a child that gave up still owes its caller an answer. Without this a
            // parent waits on `assistant` forever with nothing anywhere saying why.
            const finished = await this.deps.things.search<Conversation>(
                spec,
                and(
                    or(
                        eq(fieldPath(spec, "status"), "done"),
                        eq(fieldPath(spec, "status"), "failed"),
                    ),
                    setButNot(
                        fieldPath(spec, "parentConversationId"),
                        fieldPath(spec, "resultDeliveredAt"),
                    ),
                    ...(cursor === undefined
                        ? []
                        : [
                              {
                                  operator: "date_range",
                                  field: fieldPath(spec, "createdAt"),
                                  from: cursor,
                              } as Constraint,
                          ]),
                ),
                PAGE_SIZE,
                byCreatedAt(spec, "ASC"),
            );

            /** The newest `createdAt` this page contained: where the next page picks up. */
            let newest = cursor;
            /** Rows in this page the pass had not already examined — its progress. */
            let fresh = 0;

            for (const child of finished) {
                const createdAt = child.data.createdAt ?? "";
                if (createdAt && (newest === undefined || createdAt > newest)) newest = createdAt;
                if (examined.has(child.docRef)) continue;
                examined.add(child.docRef);
                fresh += 1;

                const parentId = child.data.parentConversationId;
                if (!parentId) continue;
                try {
                    const parent = await this.deps.things.get<Conversation>(
                        SPECS.Conversation_DM,
                        `Conversation_DM/${parentId}`,
                    );

                    // A caller that has already finished is told in the log, not in its transcript.
                    // Appending would rewrite a Conversation that is done — and as `role:"user"`,
                    // `kind:"answer"`, which is what `buildMessages` turns into a user message, so it
                    // corrupts the record for any later reader including a real provider. The result is
                    // not lost: it lives on the child, which the UI shows.
                    //
                    // Scoped to *terminal* callers deliberately. A parent that is `running`, or waiting
                    // on something else, may still legitimately be owed the answer — a `wait` caller
                    // whose lease expired and which escalated, for one — and declining there would lose
                    // the result for good once `resultDeliveredAt` is stamped.
                    if (parent.data.status === "done" || parent.data.status === "failed") {
                        log.info("a child finished for a caller that had already moved on", {
                            child: child.thingId,
                            parentId,
                            childStatus: child.data.status,
                        });
                        child.data.resultDeliveredAt = nowIso();
                        await this.deps.things.update(
                            SPECS.Conversation_DM,
                            child.docRef,
                            child.data as Record<string, unknown>,
                        );
                        delivered += 1;
                        continue;
                    }

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

            // A short page is the end of the sweep; the next pass starts from the beginning. See
            // scanAnswered for why the cursor is allowed to go backwards only here.
            if (finished.length < PAGE_SIZE) {
                this.resultDeliveryCursor = undefined;
                return delivered;
            }
            if (fresh === 0) {
                // A full page of rows all already examined: more than PAGE_SIZE finished children
                // share one createdAt second. Step one second past the group to keep the sweep
                // moving, said out loud — an operator seeing this has undelivered results in the tail.
                const tied = parseIso(newest);
                log.warn(
                    `more than ${PAGE_SIZE} finished child Conversations share one createdAt second, ` +
                        `so some cannot be reached by this scan; stepping past them`,
                    { createdAt: newest, examined: examined.size },
                );
                if (tied === undefined) {
                    this.resultDeliveryCursor = undefined;
                    return delivered;
                }
                cursor = nowIso(new Date(tied + 1_000));
                continue;
            }
            cursor = newest;
        }

        // Out of pages, not out of children. Remember where the sweep got to.
        this.resultDeliveryCursor = cursor;
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

    // ---------------------------------------------------------------- scan 7: schedules

    /**
     * The only scan whose input is **configuration rather than the store** (ADR-0016).
     *
     * It reads `cron` off each enabled Assistant's `schedule` Triggers, resolves the most recent due
     * instant, and births a Conversation for it unless one already exists. Three properties fall out
     * of only ever evaluating the *latest* instant, rather than out of extra code here:
     *
     *   - **exactly once**, across a re-scan, a restart and a replayed watermark, because
     *     `(assistantKey, scheduledFor)` is recomputed identically every time;
     *   - **catch-up once**, because three missed slots have one latest instant between them;
     *   - **no watermark**, which is the whole point — a mark written *after* the work is the thing
     *     ADR-0012 exists to avoid, and a schedule that chased an insurer would chase them twice.
     *
     * It runs last so that its `birthsThisHour` increment is persisted by the heartbeat write that
     * immediately follows, rather than needing a store write of its own.
     */
    private async scanScheduled(
        state: Stored<RuntimeState>,
        assistants: Stored<Assistant>[],
    ): Promise<number> {
        const now = new Date();
        let births = 0;

        for (const assistant of assistants) {
            const key = assistant.data.key ?? "";
            for (const trigger of assistant.data.triggers ?? []) {
                if (trigger.kind !== "schedule") continue;
                const cron = trigger.cron?.trim();
                if (!cron) {
                    this.noteBadCron(key, "its schedule Trigger carries no cron expression");
                    continue;
                }

                let due: string | undefined;
                try {
                    due = latestDueInstantBefore(now, cron, this.deps.scheduleTimezone);
                } catch (error) {
                    // A configuration error on a Thing the User owns. Logged and skipped — it does
                    // NOT disable the Assistant: nothing in this change disables an Assistant, and a
                    // Schedule cannot run away, so there is no runaway to bound.
                    this.noteBadCron(key, describeError(error));
                    continue;
                }
                if (due === undefined) continue; // not yet due — one comparison, no query

                // Already served: one comparison and one query, and no budget consulted. The budget
                // check comes *after* this deliberately — ADR-0016 promises a served slot costs
                // nothing, and checking first meant an exhausted hour logged a warning on every scan
                // about a birth that was never going to happen.
                if (await this.scheduledConversationExists(key, due)) {
                    this.stalledSlots.delete(key);
                    continue;
                }
                // The skip rule: two live Conversations for one recurring errand produce two Open
                // Questions the User cannot tell apart. So a Schedule stalls rather than accumulates,
                // and the stall already has the unanswered question that caused it in the inbox.
                if (await this.anyUnfinishedScheduledConversation(key)) {
                    this.noteStalledSchedule(key, due);
                    continue;
                }
                this.stalledSlots.delete(key);

                if (!this.withinBirthBudget(state)) {
                    log.warn("birth budget for this hour is exhausted; a due schedule was not served", {
                        assistant: key,
                        scheduledFor: due,
                    });
                    return births;
                }

                await this.deps.birth({
                    assistant,
                    scheduledFor: due,
                    // The wall clock here too, for the same reason the prompt uses it: this is the
                    // line a human reads in the Conversations list. The UTC instant is one column
                    // over, where a machine identity belongs.
                    title: `${assistant.data.name ?? key}: scheduled ${describeInstant(due, this.deps.scheduleTimezone)}`,
                    prompt: scheduledPrompt(due, this.deps.scheduleTimezone),
                    idempotencyKey: `birth:${key}:${due}`,
                });
                births += 1;
                state.data.birthsThisHour = (state.data.birthsThisHour ?? 0) + 1;
                log.info("a scheduled conversation was born", { assistant: key, scheduledFor: due });
            }
        }
        return births;
    }

    /**
     * Say once that a Schedule is stalled, not once every two seconds.
     *
     * The stall is the designed, healthy behaviour of the skip rule, and after ADR-0018 it is the
     * *common* case: the Accountant waits on an approval at least once per booking. Warning on every
     * scan would be 30 lines a minute about a system working as intended, and an operator who is
     * warned about healthy behaviour stops reading the warnings — which is the argument
     * {@link noteFrozenFrontier} already makes about the watermark, and the shape ADR-0016 asked for
     * when it said repeated skipping should be warned about "the way a pinned watermark is".
     *
     * In memory, so a restart re-arms it: a stall that survives a restart is worth hearing again.
     */
    private noteStalledSchedule(assistantKey: string, scheduledFor: string): void {
        const previous = this.stalledSlots.get(assistantKey);
        if (previous?.scheduledFor !== scheduledFor) {
            this.stalledSlots.set(assistantKey, { scheduledFor, since: Date.now(), warned: false });
            return;
        }
        if (previous.warned || Date.now() - previous.since < STALLED_SCHEDULE_WARN_AFTER_MS) return;
        previous.warned = true;
        log.warn(
            `the "${assistantKey}" schedule has been held for ${Math.round((Date.now() - previous.since) / 60_000)} ` +
                `minutes because an earlier run is unfinished; answer its Open Question to let it run again`,
            { assistant: assistantKey, scheduledFor },
        );
    }

    /**
     * Say once per process that an Assistant's cron cannot be read.
     *
     * In memory, so a restart says it again — which is the right way round for a genuine
     * misconfiguration, and persisting it would put a logging detail in the store.
     */
    private noteBadCron(assistantKey: string, reason: string): void {
        if (this.badCrons.has(assistantKey)) return;
        this.badCrons.add(assistantKey);
        log.error(
            `the "${assistantKey}" assistant has a schedule that cannot be read, so it will never ` +
                `fire; fix the cron expression on the Assistant`,
            { assistant: assistantKey, reason },
        );
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

    /**
     * Has this slot already been served? The same shape as the subject query above, which is the
     * point of ADR-0016: a Schedule gets an identity so birth stays one query rather than two
     * mechanisms.
     */
    private async scheduledConversationExists(
        assistantKey: string,
        scheduledFor: string,
    ): Promise<boolean> {
        const found = await this.deps.things.search<Conversation>(
            SPECS.Conversation_DM,
            and(
                eq(fieldPath(SPECS.Conversation_DM, "assistantKey"), assistantKey),
                eq(fieldPath(SPECS.Conversation_DM, "scheduledFor"), scheduledFor),
            ),
            1,
        );
        return found.length > 0;
    }

    /** Is an earlier slot for this Assistant still in flight? Two `or`ed statuses, one query. */
    private async anyUnfinishedScheduledConversation(assistantKey: string): Promise<boolean> {
        const found = await this.deps.things.search<Conversation>(
            SPECS.Conversation_DM,
            and(
                eq(fieldPath(SPECS.Conversation_DM, "assistantKey"), assistantKey),
                not(unset(fieldPath(SPECS.Conversation_DM, "scheduledFor"))),
                or(
                    eq(fieldPath(SPECS.Conversation_DM, "status"), "running"),
                    eq(fieldPath(SPECS.Conversation_DM, "status"), "waiting"),
                ),
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
 * The prompt a scheduled Conversation is born with.
 *
 * **Stable first, volatile last (#11).** The standing instruction comes first and never varies; the
 * due instant — the first time-varying value in this system to reach a prompt at all — comes last.
 * The rule is free to follow and only free *before* something breaks it: a prompt whose opening
 * words change on every firing is a prompt no provider can cache and no reader can diff.
 *
 * The closing sentence is the whole of item 7. A scheduled Conversation that finds nothing to do
 * needs no mechanism to stay quiet — [ADR-0015](../../../docs/adr/0015-nothing-ends-silently.md)
 * demands noise only when something *failed*, and nothing failed — it needs to be *told* that
 * finishing with "nothing to do" is a complete answer. Without that, the first useful schedule
 * produces an Open Question per firing.
 */
export function scheduledPrompt(scheduledFor: string, timezone: string): string {
    return [
        `This is a scheduled run. Nobody is waiting for it.`,
        ``,
        `Do the standing work your instructions describe: look at how things are **now** and act on`,
        `what you find. This is not a backlog to work through — earlier runs are done with, and if`,
        `three were missed you are being asked once, about today.`,
        ``,
        `**If there is nothing to do, say so in a sentence and finish.** That is a complete and`,
        `successful answer, and it is the usual one. Do not raise a question to report that there was`,
        `nothing to report, and do not invent work to justify the run.`,
        ``,
        `If you do find something that needs a human, ask about **all of it in one question** rather`,
        `than one question per item — until that question is answered, this schedule does not run again.`,
        ``,
        `Scheduled for: ${describeInstant(scheduledFor, timezone)}.`,
    ].join("\n");
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
