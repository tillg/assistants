/**
 * Scan 1 and the watermark.
 *
 * `loop.test.ts` covers what happens inside a Turn. Nothing covered the query that decides which
 * Things become Turns in the first place — which is how four separate ways of losing a Thing for
 * good got through. The watermark's invariant is the whole of it: **birth is exactly-once by
 * query**, and the watermark may never pass a Thing that has not been decided.
 */

import { describe, expect, it, vi } from "vitest";
import { buildHarness, clearCatalogue, nowIso, putCatalogue, type Harness } from "./support/harness.js";
import { SPECS } from "../src/a12/things.js";
import { RUNTIME_STATE_KEY } from "../src/watcher/watcher.js";
import { isPaused, setPaused } from "../src/bootstrap/bootstrap.js";
import type { Assistant, Conversation, RuntimeState, Stored } from "../src/domain/types.js";

/** The watermark the Runtime would have had when the batch landed. */
async function seedState(harness: Harness, watermark: string): Promise<void> {
    await harness.things.create(SPECS.RuntimeState_DM, {
        singletonKey: RUNTIME_STATE_KEY,
        paused: false,
        birthsThisHour: 0,
        birthWindowStartedAt: nowIso(),
        watermark,
        idempotencyKey: `runtime-state:${RUNTIME_STATE_KEY}`,
    });
}

function state(harness: Harness): Promise<Stored<RuntimeState>> {
    return harness.watcher.loadState();
}

async function conversations(harness: Harness): Promise<Stored<Conversation>[]> {
    return harness.things.search<Conversation>(SPECS.Conversation_DM, undefined, 1000);
}

async function subjectsBirthed(harness: Harness): Promise<Set<string>> {
    return new Set((await conversations(harness)).map((row) => row.data.subjectThingId ?? ""));
}

describe("the materialised scan (scan 1)", () => {
    it("does not lose Things when more than one page of candidates is waiting", async () => {
        // The query asks for one page of 100. With 150 waiting, the 50 it did not look at were
        // still stepped over, because the new watermark was the *maximum* createdAt in an
        // arbitrary window rather than the end of a contiguous run. README's "birth is
        // exactly-once by query" quietly became at-most-once — reachable by any bulk import.
        const t0 = Date.now() - 3_600_000;
        const harness = buildHarness([], { maxBirthsPerHour: 1000 });
        await harness.seedAssistant();
        await seedState(harness, nowIso(new Date(t0)));

        // `createdAt` ascends with the index but the rows are inserted newest-50 first: createdAt
        // is a field a connector sets from the source (an email's date), not the insert time.
        const order = [...Array(50).keys()].map((index) => index + 100).concat([...Array(100).keys()]);
        const ids: string[] = [];
        for (const index of order) {
            const thing = await harness.things.create(SPECS.Document_DM, {
                title: `bulk ${index}`,
                createdAt: nowIso(new Date(t0 + 1_000 + index * 1_000)),
                idempotencyKey: `bulk-${index}`,
            });
            ids.push(thing.thingId);
        }

        // Four scans is more than enough for two pages; the point is that it converges at all.
        for (let pass = 0; pass < 4; pass += 1) await harness.watcher.scan();

        const birthed = await subjectsBirthed(harness);
        const missing = ids.filter((id) => !birthed.has(id));
        expect(missing).toHaveLength(0);
    });

    it("picks up a Thing the User created in the web application, which has no createdAt", async () => {
        // The four machine fields are deliberately on no form, and A12's form engine offers no save
        // hook that could stamp one (see BUG-36), so a Thing created by a human in the UI carries no
        // `createdAt` at all — only `__meta.createdAt`. The materialised scan constrains on *our*
        // `createdAt` with a `date_range`, and a `date_range` cannot match an absent value, so such a
        // Thing is invisible to the watcher for ever.
        //
        // Which means the User cannot start work by creating a Document. That is the product's
        // central premise — "a Document arrives and an Assistant notices" — failing on the one path a
        // human actually uses. Every test and the demo loader go through `ThingRepository.create`,
        // which stamps the field, so nothing caught it.
        const t0 = Date.now() - 3_600_000;
        const harness = buildHarness([], { maxBirthsPerHour: 1000 });
        await harness.seedAssistant();
        await seedState(harness, nowIso(new Date(t0)));

        // Exactly what the form writes: the business fields, and none of the machine fields.
        const docRef = await harness.store.addDocument("Document_DM", {
            Document: { Title: "scanned by hand, in the browser", Source: "post" },
        });
        const thingId = docRef.slice(docRef.indexOf("/") + 1);

        await harness.watcher.scan();
        await harness.watcher.scan();

        expect((await subjectsBirthed(harness)).has(thingId)).toBe(true);
    });

    it("stamps createdAt without writing back anything else the User has changed", async () => {
        // The stamp reads the Thing and then writes. Writing the *snapshot* back — rather than only
        // the field being filled in — reverts every edit the User saved in between, because
        // `ThingRepository.update` merges what it is given over the current document.
        //
        // Reachable in the ordinary way: `Party_DM` is trigger-eligible, a Party created in the web
        // application has no `createdAt`, and a User who creates one and then corrects it is doing
        // the most obvious thing there is. The scan interval is two seconds, so the window is the
        // whole of the time the User spends typing.
        const t0 = Date.now() - 3_600_000;
        const harness = buildHarness([], { maxBirthsPerHour: 1000 });
        await harness.seedAssistant();
        await seedState(harness, nowIso(new Date(t0)));

        const docRef = await harness.store.addDocument("Party_DM", {
            Party: { Name: "Praxis Dr. Meyer", Kind: "organisation", City: "Köln" },
        });

        // The User's save lands between the scan reading the Thing and the scan writing to it.
        const query = harness.store.query.bind(harness.store);
        let edited = false;
        harness.store.query = async (spec) => {
            const result = await query(spec);
            if (!edited && spec.targetDocumentModel === "Party_DM") {
                edited = true;
                const row = harness.store.rows.get(docRef)!;
                (row.document["Party"] as Record<string, unknown>)["City"] = "Frechen";
            }
            return result;
        };

        await harness.watcher.scan();

        const after = await harness.store.getDocument(docRef);
        const party = after.document["Party"] as Record<string, unknown>;
        expect(edited).toBe(true);
        expect(party["City"]).toBe("Frechen");
        // ...and the stamp still did its job.
        expect(String(party["CreatedAt"] ?? "")).not.toBe("");
    });

    it("holds the watermark behind a Thing whose creating Conversation is still running", async () => {
        // The Receptionist creating an Invoice while its own Conversation still runs. The Invoice is
        // correctly skipped on that pass — and any Thing created a second later used to bury it,
        // because the `continue` for a running creator happened before the watermark logic could
        // see that anything had been set aside.
        const t0 = Date.now() - 3_600_000;
        const harness = buildHarness([], { maxBirthsPerHour: 1000 });
        await harness.seedAssistant();
        const seededWatermark = nowIso(new Date(t0));
        await seedState(harness, seededWatermark);

        // A Conversation that is still running, and a Document it created.
        const blocker = await harness.things.create(SPECS.Conversation_DM, {
            assistantKey: "receptionist",
            status: "running",
            leaseUntil: nowIso(new Date(Date.now() + 600_000)),
            idempotencyKey: "blocker",
        });
        const skipped = await harness.things.create(SPECS.Document_DM, {
            title: "created by a conversation that is still running",
            createdAt: nowIso(new Date(t0 + 60_000)),
            createdByConversationId: blocker.thingId,
            idempotencyKey: "skipped",
        });
        const ordinary = await harness.things.create(SPECS.Document_DM, {
            title: "ordinary, and later",
            createdAt: nowIso(new Date(t0 + 120_000)),
            idempotencyKey: "ordinary",
        });

        await harness.watcher.scan();

        // The later Thing is birthed immediately — freezing the watermark must not stall throughput.
        let birthed = await subjectsBirthed(harness);
        expect(birthed.has(ordinary.thingId)).toBe(true);
        expect(birthed.has(skipped.thingId)).toBe(false);
        // But the watermark did not step over the one that was set aside.
        expect((await state(harness)).data.watermark).toBe(seededWatermark);

        // When the blocking Conversation finishes, the skipped Thing is birthed after all.
        await harness.things.update(SPECS.Conversation_DM, blocker.docRef, {
            ...blocker.data,
            status: "done",
            leaseUntil: "",
        });
        await harness.watcher.scan();

        birthed = await subjectsBirthed(harness);
        expect(birthed.has(skipped.thingId)).toBe(true);
    });

    it("says so when a frontier stays pinned, once rather than on every scan", async () => {
        // A frozen frontier is correct — nothing is lost — but it is silent, and a Conversation
        // that never finishes pins its Model's watermark for ever. Nothing behind that point is
        // birthed again and no line anywhere says why.
        const t0 = Date.now() - 3_600_000;
        const harness = buildHarness([], { maxBirthsPerHour: 1000 });
        await harness.seedAssistant();
        await seedState(harness, nowIso(new Date(t0)));

        // A lease far enough out that the freeze is the *only* reason nothing moves.
        const blocker = await harness.things.create(SPECS.Conversation_DM, {
            assistantKey: "receptionist",
            status: "running",
            leaseUntil: nowIso(new Date(Date.now() + 86_400_000)),
            idempotencyKey: "blocker",
        });
        await harness.things.create(SPECS.Document_DM, {
            title: "created by a Conversation that never finishes",
            createdAt: nowIso(new Date(t0 + 60_000)),
            createdByConversationId: blocker.thingId,
            idempotencyKey: "never-birthed",
        });

        const pinned = (line: string): boolean => line.includes("pinned");
        const warnings: string[] = [];
        const console_ = vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
            warnings.push(String(line));
        });

        try {
            await harness.watcher.scan();
            // One frozen scan is not news: an ordinary Conversation finishes in seconds, and the
            // scan runs every two. Warning here would warn on every healthy chain in the system.
            expect(warnings.filter(pinned)).toHaveLength(0);

            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(new Date(Date.now() + 6 * 60_000));
            await harness.watcher.scan();
            expect(warnings.filter(pinned)).toHaveLength(1);
            expect(warnings.filter(pinned)[0]).toContain("Document_DM");

            // Still stuck ten minutes later, and the operator has already been told once.
            vi.setSystemTime(new Date(Date.now() + 10 * 60_000));
            await harness.watcher.scan();
            expect(warnings.filter(pinned)).toHaveLength(1);
        } finally {
            vi.useRealTimers();
            console_.mockRestore();
        }
    });

    it("does not let one Model's progress bury another Model's skipped Thing", async () => {
        // The four trigger-eligible Models share one watermark, so `newestSeen` was raised by any
        // later Thing in the same pass — including a Thing of a different Model.
        const t0 = Date.now() - 3_600_000;
        const harness = buildHarness([], { maxBirthsPerHour: 1000 });
        await harness.seedAssistant({
            triggers: [
                { kind: "thing-materialised", modelFilter: "Document_DM" },
                { kind: "thing-materialised", modelFilter: "Invoice_DM" },
            ],
        });
        const seededWatermark = nowIso(new Date(t0));
        await seedState(harness, seededWatermark);

        const blocker = await harness.things.create(SPECS.Conversation_DM, {
            assistantKey: "receptionist",
            status: "running",
            leaseUntil: nowIso(new Date(Date.now() + 600_000)),
            idempotencyKey: "blocker",
        });
        const blockedInvoice = await harness.things.create(SPECS.Invoice_DM, {
            invoiceNumber: "BLOCKED-1",
            createdAt: nowIso(new Date(t0 + 60_000)),
            createdByConversationId: blocker.thingId,
            idempotencyKey: "blocked-invoice",
        });
        await harness.things.create(SPECS.Document_DM, {
            title: "a different Model, later",
            createdAt: nowIso(new Date(t0 + 120_000)),
            idempotencyKey: "later-document",
        });

        await harness.watcher.scan();

        expect((await subjectsBirthed(harness)).has(blockedInvoice.thingId)).toBe(false);
        // The Document's progress must not carry the watermark past the Invoice that was skipped.
        expect((await state(harness)).data.watermark! < nowIso(new Date(t0 + 60_000))).toBe(true);
    });
});

/**
 * The startup check (ADR-0019).
 *
 * The per-Turn refusal is what makes "no fallback to the seeds" true under a live edit, but on its
 * own it produces a stack that boots into a guaranteed-failing loop and reports it one identical
 * error at a time. So the watcher looks before it scans — and looks again on every scan, so that
 * bootstrapping a running stack heals it without a restart.
 */
describe("the catalogue check in front of the scan", () => {
    /** A Document waiting to be birthed, and the watermark that would let it be. */
    async function workWaiting(harness: Harness): Promise<void> {
        const t0 = Date.now() - 3_600_000;
        await harness.seedAssistant();
        await seedState(harness, nowIso(new Date(t0)));
        await harness.things.create(SPECS.Document_DM, {
            title: "a Document nobody will look at until the catalogue is there",
            createdAt: nowIso(new Date(t0 + 60_000)),
            idempotencyKey: "waiting",
        });
    }

    it("does not scan while the catalogue is empty, says why once, and reports unhealthy", async () => {
        const harness = buildHarness([{ text: "Done.", finishReason: "answered" }]);
        await workWaiting(harness);
        clearCatalogue(harness.store);
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});

        for (let pass = 0; pass < 3; pass += 1) await harness.watcher.scan();

        // Nothing was born, and nothing was advanced.
        expect(await conversations(harness)).toHaveLength(0);
        // The heartbeat is what the compose healthcheck reads, and a scan that did not run must not
        // stamp it: an unhealthy container is how "the catalogue is missing" reaches an operator who
        // is not reading the log.
        expect((await state(harness)).data.heartbeatAt).toBeFalsy();

        const complaints = errors.mock.calls
            .map((call) => String(call[0] ?? ""))
            .filter((line) => line.includes("just bootstrap"));
        // Once per outage, not thirty times a minute — the same argument the pinned-watermark and
        // held-schedule warnings make. The healthcheck is the continuous signal; this is the reason.
        expect(complaints).toHaveLength(1);
        expect(complaints[0]).toMatch(/catalogue/i);
        errors.mockRestore();
    });

    it("does not scan when the catalogue cannot be read at all", async () => {
        const harness = buildHarness([]);
        await workWaiting(harness);
        const query = harness.store.query.bind(harness.store);
        harness.store.query = async (spec) => {
            if (spec.targetDocumentModel === "Operation_DM") throw new Error("the store is down");
            return query(spec);
        };
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});

        await harness.watcher.scan();

        expect(await conversations(harness)).toHaveLength(0);
        expect(errors.mock.calls.map((call) => String(call[0] ?? "")).join("\n")).toMatch(
            /the store is down/,
        );
        errors.mockRestore();
    });

    it("resumes scanning when a catalogue appears, without a restart, and says so once", async () => {
        const harness = buildHarness([{ text: "Done.", finishReason: "answered" }]);
        await workWaiting(harness);
        const catalogue = harness.catalogue;
        clearCatalogue(harness.store);
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        const infos = vi.spyOn(console, "info").mockImplementation(() => {});

        await harness.watcher.scan();
        expect(await conversations(harness)).toHaveLength(0);

        // `just bootstrap` against the running stack.
        putCatalogue(harness.store, catalogue);
        for (let pass = 0; pass < 3; pass += 1) await harness.watcher.scan();

        expect(await conversations(harness)).toHaveLength(1);
        expect((await state(harness)).data.heartbeatAt).toBeTruthy();

        const resumed = infos.mock.calls
            .map((call) => String(call[0] ?? ""))
            .filter((line) => line.includes("scanning resumed"));
        // "It seems to be working now" becomes evidence — once, at the transition, not per scan.
        expect(resumed).toHaveLength(1);
        expect(resumed[0]).toMatch(new RegExp(`catalogue found: ${catalogue.length} Operations`));
        errors.mockRestore();
        infos.mockRestore();
    });

    it("says nothing at all when the catalogue was there from the first scan", async () => {
        const harness = buildHarness([{ text: "Done.", finishReason: "answered" }]);
        await workWaiting(harness);
        const infos = vi.spyOn(console, "info").mockImplementation(() => {});

        await harness.watcher.scan();

        expect(
            infos.mock.calls.filter((call) => String(call[0] ?? "").includes("scanning resumed")),
        ).toHaveLength(0);
        infos.mockRestore();
    });
});

describe("the answered scan (scan 2)", () => {
    it("resumes a Conversation whose answer is waiting behind the first page", async () => {
        // The scan read one page of 100 waiting Conversations and iterated exactly that, with no
        // paging, no watermark and no ordering — so which 100 it got was whatever window the store
        // happened to hand back. Measured on a live stack with 501 waiting Conversations: an
        // Accountant kept `waitingFor = "user"` and a `currentQuestionId` pointing at a question the
        // User had answered ten minutes earlier, and nothing ever came back for it. Terminal and
        // silent, with the heartbeat green throughout — the same failure the scan's own comment
        // records having fixed once already, reintroduced by the cap.
        //
        // The blockers here carry questions that are **not** answered, and that is the whole point:
        // with every question answered the cap only costs a pass, because a resumed Conversation
        // leaves the query. It is the unanswered majority — which is what a real inbox is — that
        // fills the page for ever and makes the loss permanent.
        const harness = buildHarness([{ text: "Thank you, noted.", finishReason: "answered" }]);
        const assistant = await harness.seedAssistant({ triggers: [] });

        const t0 = Date.now() - 3_600_000;
        /** One waiting Conversation with one Open Question, answered or not. Oldest first. */
        async function waiting(index: number, answered: boolean): Promise<string> {
            const question = await harness.things.create(SPECS.OpenQuestion_DM, {
                conversationId: `pending-${index}`,
                assistantKey: assistant.data.key ?? "",
                kind: "free-text",
                prompt: `Question ${index}?`,
                ...(answered ? { text: "Yes, go ahead.", answeredAt: nowIso() } : {}),
                idempotencyKey: `question-${index}`,
            });
            const conversation = await harness.things.create(SPECS.Conversation_DM, {
                assistantKey: assistant.data.key ?? "",
                title: `waiting ${index}`,
                status: "waiting",
                waitingFor: "user",
                currentQuestionId: question.thingId,
                turnCount: 1,
                maxTurns: 20,
                escalationCount: 0,
                entries: [{ seq: 1, at: nowIso(), role: "user", kind: "prompt", text: "Do the thing." }],
                // Distinct seconds, ascending with the index, so "behind the first page" is a fact
                // about the data rather than about the order the store felt like answering in.
                createdAt: nowIso(new Date(t0 + index * 1_000)),
                idempotencyKey: `waiting-${index}`,
            });
            return conversation.docRef;
        }

        for (let index = 0; index < 120; index += 1) await waiting(index, false);
        const answeredLast = await waiting(120, true);

        // Bounded: a handful of passes, not "eventually". Three is enough for any mechanism that
        // covers 121 rows at all, and a fourth would hide a cliff rather than expose one.
        for (let pass = 0; pass < 3; pass += 1) await harness.watcher.scan();

        const resumed = await harness.conversation(answeredLast);
        expect(resumed.data.currentQuestionId).toBe("");
        expect(resumed.data.waitingFor).toBe("");
        expect(resumed.data.status).not.toBe("waiting");
        expect((resumed.data.entries ?? []).some((entry) => entry.kind === "answer")).toBe(true);

        // And the unanswered 120 are left exactly where they were: the fix is about reaching them,
        // not about deciding for the User.
        const stillWaiting = (await conversations(harness)).filter(
            (row) => row.data.status === "waiting",
        );
        expect(stillWaiting).toHaveLength(120);
    });
});

describe("result delivery (scan 5)", () => {
    it("does not rewrite the transcript of a caller that has already finished", async () => {
        // `awaitMode: "detach"` still sets `parentConversationId`, so the child matches scan 5 and
        // its result was appended — as a `role:"user"`, `kind:"answer"` entry — into a Conversation
        // that finished two Turns earlier, and written back. The comment at the re-run guard says
        // "a result arriving for a Conversation that has already moved on is a log line, never a
        // resurrection"; it declined to re-run the parent but not to rewrite it.
        const harness = buildHarness([
            {
                assistant: "receptionist",
                turn: 0,
                toolCalls: [
                    {
                        name: "assistant__call__accountant",
                        arguments: { prompt: "have a look when you can", awaitMode: "detach" },
                    },
                ],
            },
            { assistant: "receptionist", turn: 1, text: "Handed it off, nothing more from me.", finishReason: "answered" },
            { assistant: "accountant", text: "booked", finishReason: "answered" },
        ]);
        const receptionist = await harness.seedAssistant({
            key: "receptionist",
            grants: [{ operationKey: "assistant.call:accountant" }],
        });
        await harness.seedAssistant({ key: "accountant", triggers: [] });
        const docRef = await harness.birth({ assistant: receptionist });

        // The detached call returns a value, so the caller keeps going and finishes.
        await harness.driver.advance(docRef);
        await harness.driver.advance(docRef);
        const finished = await harness.conversation(docRef);
        expect(finished.data.status).toBe("done");
        const entriesWhenDone = (finished.data.entries ?? []).length;

        const child = (await conversations(harness)).find(
            (row) => row.data.assistantKey === "accountant",
        )!;
        await harness.driver.advance(child.docRef);

        await harness.watcher.scan();
        await harness.watcher.scan();

        const after = await harness.conversation(docRef);
        expect((after.data.entries ?? []).length).toBe(entriesWhenDone);
        expect(after.data.status).toBe("done");
        // Settled, so scan 5 does not retry it every two seconds for ever.
        const settledChild = await harness.conversation(child.docRef);
        expect(settledChild.data.resultDeliveredAt).toBeTruthy();
    });

    it("reaches a deliverable child even when 100+ undeliverable ones sit ahead of it", async () => {
        // BUG-01: scan 5 read one unordered window of 100. A child whose parent was deleted throws
        // on delivery, is never stamped, and stays in the set for ever — so a hundred of them could
        // fill the window and shadow every deliverable child queued behind. The cursor sweep (the
        // twin of scanAnswered) walks past the stuck rows. Here: 100 orphans, then one deliverable
        // child that is newest, so an ordered sweep meets it only on a later page.
        const harness = buildHarness([]);
        const t0 = Date.now() - 3_600_000;
        await seedState(harness, nowIso(new Date(t0)));

        // A terminal parent, so delivery takes the "already moved on" branch and needs no model.
        const parent = await harness.things.create(SPECS.Conversation_DM, {
            assistantKey: "receptionist",
            status: "done",
            createdAt: nowIso(new Date(t0)),
            idempotencyKey: "real-parent",
        });
        for (let i = 0; i < 100; i += 1) {
            await harness.things.create(SPECS.Conversation_DM, {
                assistantKey: "accountant",
                status: "done",
                result: "orphan",
                parentConversationId: `does-not-exist-${i}`,
                createdAt: nowIso(new Date(t0 + i * 1_000)),
                idempotencyKey: `orphan-${i}`,
            });
        }
        const child = await harness.things.create(SPECS.Conversation_DM, {
            assistantKey: "accountant",
            status: "done",
            result: "the answer",
            parentConversationId: parent.thingId,
            createdAt: nowIso(new Date(t0 + 200_000)),
            idempotencyKey: "deliverable",
        });

        await harness.watcher.scan();

        const settled = await harness.conversation(child.docRef);
        expect(settled.data.resultDeliveredAt, "the deliverable child was reached past the stuck rows").toBeTruthy();
    });
});

describe("the woken scan (scan 3)", () => {
    it("wakes a due Conversation buried behind 100 not-yet-due sleepers", async () => {
        // BUG-02: scanWoken read one unordered window of 100 with no `wakeAt <= now` bound, then
        // skipped the not-yet-due rows in memory. A page of future sleepers meant every due
        // Conversation past position 100 was never fetched and missed its deadline for ever. The
        // query is now bounded to due rows and ordered earliest-first.
        const harness = buildHarness([{ text: "carried on", finishReason: "answered" }]);
        const t0 = Date.now() - 3_600_000;
        await seedState(harness, nowIso(new Date(t0)));
        await harness.seedAssistant({ key: "sleeper", triggers: [] });

        for (let i = 0; i < 100; i += 1) {
            await harness.things.create(SPECS.Conversation_DM, {
                assistantKey: "sleeper",
                status: "waiting",
                waitingFor: "user",
                wakeAt: nowIso(new Date(Date.now() + 3_600_000 + i * 1_000)),
                createdAt: nowIso(new Date(t0 + i * 1_000)),
                idempotencyKey: `future-sleeper-${i}`,
            });
        }
        const due = await harness.things.create(SPECS.Conversation_DM, {
            assistantKey: "sleeper",
            status: "waiting",
            waitingFor: "user",
            wakeAt: nowIso(new Date(Date.now() - 60_000)),
            createdAt: nowIso(new Date(t0 + 500_000)),
            entries: [{ seq: 1, at: nowIso(), role: "user", kind: "prompt", text: "wake me" }],
            idempotencyKey: "due-sleeper",
        });

        await harness.watcher.scan();

        const after = await harness.conversation(due.docRef);
        expect(after.data.wakeAt ?? "", "the due Conversation was woken past the future sleepers").toBe("");
    });
});

describe("the RuntimeState the scan writes back", () => {
    it("does not undo a pause issued while the scan was in flight", async () => {
        // The global kill switch. `scan()` reads the state at the top of a pass that takes seconds
        // and the watermark write at the end used to put the whole stale copy back, silently
        // reverting a `just pause` issued in between — measured at 3 reverts in 25 attempts, with
        // `just pause` still logging "runtime paused" and exiting 0.
        //
        // The pause is injected deterministically rather than by racing: at the moment the birth
        // writes its Conversation, which is inside the window between the read and the write.
        const t0 = Date.now() - 3_600_000;
        const harness = buildHarness([], { maxBirthsPerHour: 1000 });
        await harness.seedAssistant();
        const seededWatermark = nowIso(new Date(t0));
        await seedState(harness, seededWatermark);
        await harness.things.create(SPECS.Document_DM, {
            title: "the Thing whose birth opens the window",
            createdAt: nowIso(new Date(t0 + 60_000)),
            idempotencyKey: "opens-the-window",
        });

        const addDocument = harness.store.addDocument.bind(harness.store);
        let injected = false;
        harness.store.addDocument = async (model, document) => {
            const docRef = await addDocument(model, document);
            if (model === "Conversation_DM" && !injected) {
                injected = true;
                await setPaused(harness.things, true);
            }
            return docRef;
        };

        await harness.watcher.scan();

        expect(injected).toBe(true);
        expect(await isPaused(harness.things)).toBe(true);
        // ...and the watermark write really did happen, so the pause survived a real write rather
        // than there being nothing to survive.
        expect((await state(harness)).data.watermark).not.toBe(seededWatermark);
    });

    it("`just pause` does not roll back the watermark on its way past", async () => {
        // The mirror of BUG-07. That was the scan trampling `paused`; this is `setPaused` — the
        // function behind `just pause` and `just resume` — trampling everything else, because it
        // reads the state and writes the whole object back. The operator flips the kill switch and
        // silently undoes the watcher's progress.
        const t0 = Date.now() - 3_600_000;
        const harness = buildHarness([], { maxBirthsPerHour: 1000 });
        await seedState(harness, nowIso(new Date(t0)));
        const ahead = nowIso(new Date(t0 + 600_000));

        // The scan writes its new watermark between `setPaused`'s read and its write.
        const query = harness.store.query.bind(harness.store);
        let advanced = false;
        harness.store.query = async (spec) => {
            const result = await query(spec);
            if (!advanced && spec.targetDocumentModel === "RuntimeState_DM") {
                advanced = true;
                const loaded = await harness.watcher.loadState();
                await harness.things.update(SPECS.RuntimeState_DM, loaded.docRef, {
                    ...loaded.data,
                    watermark: ahead,
                });
            }
            return result;
        };

        await setPaused(harness.things, true);

        expect(advanced).toBe(true);
        expect(await isPaused(harness.things)).toBe(true);
        expect((await state(harness)).data.watermark).toBe(ahead);
    });

    it("does not roll back a watermark another writer has moved forward", async () => {
        // `paused` was the only field carried forward, so anything else a second writer had
        // advanced was trampled by the stale in-memory copy. `just demo-data` moves the watermark
        // forward for exactly this reason, and losing that puts the demo set back on the work queue.
        const t0 = Date.now() - 3_600_000;
        const harness = buildHarness([], { maxBirthsPerHour: 1000 });
        await harness.seedAssistant();
        await seedState(harness, nowIso(new Date(t0)));

        await harness.things.create(SPECS.Document_DM, {
            title: "the Thing whose birth opens the window",
            createdAt: nowIso(new Date(t0 + 60_000)),
            idempotencyKey: "opens-the-window",
        });

        // A second writer moves the watermark forward *while* the scan holds its own copy — the
        // same window the pause test uses, because it is the same window.
        const ahead = nowIso(new Date(t0 + 600_000));
        const addDocument = harness.store.addDocument.bind(harness.store);
        let injected = false;
        harness.store.addDocument = async (model, document) => {
            const docRef = await addDocument(model, document);
            if (model === "Conversation_DM" && !injected) {
                injected = true;
                const loaded = await harness.watcher.loadState();
                await harness.things.update(SPECS.RuntimeState_DM, loaded.docRef, {
                    ...loaded.data,
                    watermark: ahead,
                });
            }
            return docRef;
        };

        await harness.watcher.scan();

        expect(injected).toBe(true);
        expect((await state(harness)).data.watermark).toBe(ahead);
    });
});

/**
 * Scan 7 — the Schedule Trigger, which until now was a field name (ADR-0016).
 *
 * The property under test everywhere here is the same one scan 1 has: **birth is exactly-once by
 * query**. What is different is that there is no subject Thing to ask about, so the identity is the
 * due instant — and the reason that is worth a decision rather than a watermark is that a watermark
 * is written *after* the work, so a Runtime that dies in between chases the insurer twice.
 */
describe("the schedule scan (scan 7)", () => {
    /** An Assistant that fires daily and does nothing else. */
    async function scheduled(harness: Harness, overrides: Partial<Assistant> = {}) {
        return harness.seedAssistant({
            key: "accountant",
            triggers: [{ kind: "schedule", cron: "0 7 * * *" }],
            grants: [{ operationKey: "thingstore.search" }],
            ...overrides,
        });
    }

    const scheduledConversations = async (harness: Harness) =>
        (await conversations(harness)).filter((row) => row.data.scheduledFor);

    it("births exactly one Conversation for a due slot, and records the instant it served", async () => {
        const harness = buildHarness([{ text: "Nothing outstanding.", finishReason: "answered" }]);
        await scheduled(harness);

        await harness.watcher.scan();

        const born = await scheduledConversations(harness);
        expect(born).toHaveLength(1);
        // The due instant, not the instant the scan noticed it — that is what makes it recomputable.
        expect(born[0]!.data.scheduledFor).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
        // Exactly one of the two identities is set (ADR-0016). Both empty is a bug; both set is a bug.
        expect(born[0]!.data.subjectThingId).toBeFalsy();
        // Stable-first, volatile-last: the standing instruction opens the prompt and the varying
        // instant closes it.
        const prompt = (born[0]!.data.entries ?? []).find((entry) => entry.kind === "prompt")!.text!;
        expect(prompt.startsWith("This is a scheduled run.")).toBe(true);
        expect(prompt.trimEnd().endsWith(").")).toBe(true);
        // The **wall clock**, not the UTC instant. `scheduledFor` is canonical UTC, so labelling it
        // with the cron's timezone — "05:00:00Z (Europe/Berlin)" — invites the model to read 05:00 as
        // local, which is exactly the midnight ambiguity the 07:00 slot was chosen to avoid.
        expect(prompt).toMatch(/Scheduled for: \d{2}:\d{2} on \d{4}-\d{2}-\d{2} \(Europe\/Berlin\)\./);
        expect(prompt).not.toContain(`${born[0]!.data.scheduledFor}Z`);
    });

    it("serves the slot exactly once across a re-scan, a restart and a replayed watermark", async () => {
        const harness = buildHarness([{ text: "Nothing outstanding.", finishReason: "answered" }]);
        await scheduled(harness);

        await harness.watcher.scan();
        // A re-scan in the same process.
        await harness.watcher.scan();
        // A restart: a brand-new Runtime over the same data, holding no memory of the first.
        const restarted = buildHarness([{ text: "Nothing outstanding.", finishReason: "answered" }], {
            store: harness.store,
        });
        await restarted.watcher.scan();
        // And a watermark rolled backwards, which is what would re-queue anything keyed on one.
        const loaded = await restarted.watcher.loadState();
        await restarted.things.update(SPECS.RuntimeState_DM, loaded.docRef, {
            ...loaded.data,
            watermark: nowIso(new Date(Date.now() - 7 * 86_400_000)),
        });
        await restarted.watcher.scan();

        expect(await scheduledConversations(restarted)).toHaveLength(1);
    });

    it("catches up once when three slots were missed, not once per slot", async () => {
        // Three days down. The scan only ever evaluates the LATEST due instant, so Saturday and
        // Sunday are never mentioned: a Schedule is a standing instruction about the state of the
        // world now, not an event log to replay.
        const harness = buildHarness([{ text: "Nothing outstanding.", finishReason: "answered" }]);
        await scheduled(harness);

        await harness.watcher.scan();

        const born = await scheduledConversations(harness);
        expect(born).toHaveLength(1);
    });

    it("skips a slot while the previous one is unfinished", async () => {
        const harness = buildHarness([]);
        const assistant = await scheduled(harness);

        // A slot from yesterday that is still waiting on the User.
        await harness.birth({ assistant, scheduledFor: "2026-08-12T05:00:00" });
        const stalled = (await scheduledConversations(harness))[0]!;
        await harness.things.update(SPECS.Conversation_DM, stalled.docRef, {
            ...stalled.data,
            status: "waiting",
            waitingFor: "user",
        });

        await harness.watcher.scan();

        // Today's slot did not give birth. Two live Conversations for one recurring errand would be
        // two Open Questions the User cannot tell apart, so a Schedule stalls rather than accumulates.
        expect(await scheduledConversations(harness)).toHaveLength(1);
        expect((await scheduledConversations(harness))[0]!.data.scheduledFor).toBe("2026-08-12T05:00:00");
    });

    it("resumes giving birth once the stalled slot has finished", async () => {
        const harness = buildHarness([{ text: "Nothing outstanding.", finishReason: "answered" }]);
        const assistant = await scheduled(harness);
        await harness.birth({ assistant, scheduledFor: "2026-08-12T05:00:00" });
        const previous = (await scheduledConversations(harness))[0]!;
        await harness.things.update(SPECS.Conversation_DM, previous.docRef, {
            ...previous.data,
            status: "done",
        });

        await harness.watcher.scan();

        expect(await scheduledConversations(harness)).toHaveLength(2);
    });

    it("says a schedule is held once, not on every scan", async () => {
        // The skip rule is the designed, healthy behaviour, and after ADR-0018 it is the *common*
        // case — the Accountant waits on an approval at least once per booking. A warning on every
        // scan is 30 lines a minute about a system working as intended, which is the same argument
        // the frozen-frontier warning already makes about the watermark.
        const harness = buildHarness([]);
        const assistant = await scheduled(harness);
        await harness.birth({ assistant, scheduledFor: "2026-08-12T05:00:00" });
        const stalled = (await scheduledConversations(harness))[0]!;
        await harness.things.update(SPECS.Conversation_DM, stalled.docRef, {
            ...stalled.data,
            status: "waiting",
            waitingFor: "user",
        });
        const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

        for (let pass = 0; pass < 5; pass += 1) await harness.watcher.scan();

        const held = warnings.mock.calls.filter((call) => String(call[0] ?? "").includes("has been held"));
        // Nothing yet: half an hour has not passed, and an approval answered over a cup of coffee
        // should never produce a line at all.
        expect(held).toHaveLength(0);
        warnings.mockRestore();
        expect(await scheduledConversations(harness)).toHaveLength(1);
    });

    it("does not consult the birth budget for a slot that has already been served", async () => {
        // ADR-0016: "a schedule whose slot is already served costs one comparison and no query".
        // Checking the budget first meant an exhausted hour logged a warning on every scan about a
        // birth that was never going to happen.
        const harness = buildHarness([{ text: "Nothing outstanding.", finishReason: "answered" }], {
            maxBirthsPerHour: 0,
        });
        await scheduled(harness);
        const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

        // First pass: due, unserved, and no budget — so it warns once and gives birth to nothing.
        await harness.watcher.scan();
        expect(await scheduledConversations(harness)).toHaveLength(0);
        expect(
            warnings.mock.calls.filter((call) => String(call[0] ?? "").includes("birth budget")),
        ).toHaveLength(1);
        warnings.mockRestore();
    });

    it("does not fire for a disabled Assistant, or while the Runtime is paused", async () => {
        const disabled = buildHarness([]);
        await scheduled(disabled, { enabled: false });
        await disabled.watcher.scan();
        expect(await scheduledConversations(disabled)).toHaveLength(0);

        const paused = buildHarness([]);
        await scheduled(paused);
        // `paused` short-circuits the whole scan, so it needs a RuntimeState to be set on.
        await paused.watcher.loadState();
        await setPaused(paused.things, true);
        await paused.watcher.scan();
        expect(await scheduledConversations(paused)).toHaveLength(0);
    });

    it("skips an unreadable cron, says so once per process, and disables nothing", async () => {
        const harness = buildHarness([]);
        await scheduled(harness, { triggers: [{ kind: "schedule", cron: "every other tuesday" }] });
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});

        await harness.watcher.scan();
        await harness.watcher.scan();
        await harness.watcher.scan();

        expect(await scheduledConversations(harness)).toHaveLength(0);
        const complaints = errors.mock.calls.filter((call) =>
            String(call[0] ?? "").includes("schedule that cannot be read"),
        );
        expect(complaints).toHaveLength(1);
        errors.mockRestore();

        // Nothing in this change disables an Assistant: a Schedule cannot run away, so there is no
        // runaway to bound.
        const [assistant] = await harness.things.search<Assistant>(SPECS.Assistant_DM, undefined, 10);
        expect(assistant!.data.enabled).not.toBe(false);
    });

    it("finishes quietly when there is nothing to do (#7)", async () => {
        // No mechanism, and that is the point: a finished Conversation is already silent, because
        // ADR-0015 demands noise only when something *failed*. What was needed was a prompt that says
        // finishing with "nothing to do" is a complete answer — without it the first useful schedule
        // produces an Open Question per firing.
        const harness = buildHarness([
            { text: "Nothing is outstanding — nothing to do.", finishReason: "answered" },
        ]);
        await scheduled(harness);

        await harness.watcher.scan();
        // Scan 7 runs last, so the newborn takes its Turn on the following pass.
        await harness.watcher.scan();

        const born = (await scheduledConversations(harness))[0]!;
        const finished = await harness.conversation(born.docRef);
        expect(finished.data.status).toBe("done");
        expect(finished.data.finishReason).toBe("answered");
        expect(finished.data.result).toContain("nothing to do");
        // The quiet Conversation IS the record that the slot was served, so nothing else is needed —
        // and no question was raised to report that there was nothing to report.
        expect(await harness.questions()).toHaveLength(0);
    });

    it("asks about everything at once rather than one item at a time", async () => {
        // Batching is a correctness property of the Skill's prose, which is not where anyone looks
        // for one: a question about the first of two unpaid invoices holds the next slot until it is
        // answered. This asserts the shape the Skill demands — one question covering both.
        const harness = buildHarness([
            {
                assistant: "accountant",
                turn: 0,
                toolCalls: [{ name: "bookkeeping__listOpenItems", arguments: {} }],
            },
            {
                assistant: "accountant",
                turn: 1,
                toolCalls: [
                    {
                        name: "ui__askUser",
                        arguments: {
                            kind: "free-text",
                            prompt:
                                "**Two things are outstanding.**\n\n- Praxis Dr. Meyer 2026-118, 96.50 EUR\n" +
                                "- Dachdecker Klein 2026-77, 1420.00 EUR\n\nShall I chase both?",
                        },
                    },
                ],
            },
        ]);
        await scheduled(harness, {
            grants: [{ operationKey: "bookkeeping.listOpenItems" }, { operationKey: "ui.askUser" }],
        });

        // Birth, then the two Turns — scan 7 runs last, so each pass moves it on by one.
        await harness.watcher.scan();
        await harness.watcher.scan();
        await harness.watcher.scan();

        const questions = await harness.questions();
        expect(questions).toHaveLength(1);
        expect(questions[0]!.data.prompt).toContain("2026-118");
        expect(questions[0]!.data.prompt).toContain("2026-77");

        // And the schedule is now stalled on it, which is exactly why one question rather than two.
        await harness.watcher.scan();
        expect(await scheduledConversations(harness)).toHaveLength(1);
    });

    it("leaves an Assistant with no schedule Trigger alone", async () => {
        const harness = buildHarness([]);
        await harness.seedAssistant({ triggers: [{ kind: "assistant-call" }] });

        await harness.watcher.scan();

        expect(await scheduledConversations(harness)).toHaveLength(0);
    });
});
