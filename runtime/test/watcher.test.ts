/**
 * Scan 1 and the watermark.
 *
 * `loop.test.ts` covers what happens inside a Turn. Nothing covered the query that decides which
 * Things become Turns in the first place — which is how four separate ways of losing a Thing for
 * good got through. The watermark's invariant is the whole of it: **birth is exactly-once by
 * query**, and the watermark may never pass a Thing that has not been decided.
 */

import { describe, expect, it } from "vitest";
import { buildHarness, nowIso, type Harness } from "./support/harness.js";
import { SPECS } from "../src/a12/things.js";
import { RUNTIME_STATE_KEY } from "../src/watcher/watcher.js";
import { isPaused, setPaused } from "../src/bootstrap/bootstrap.js";
import type { Conversation, RuntimeState, Stored } from "../src/domain/types.js";

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
            tools: [{ operation: "assistant.call:accountant" }],
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
