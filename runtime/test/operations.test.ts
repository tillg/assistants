/**
 * The Operations at their own boundary.
 *
 * `loop.test.ts` drives Operations through a scripted model, which is the right shape for testing the
 * loop's branching and the wrong one for testing what a single Operation does with a particular
 * argument. These call `execute` directly, so the assertion is about the Operation's answer rather
 * than about the transcript it ends up in.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildHarness, nowIso, SPECS, type Harness } from "./support/harness.js";
import type { OperationContext, OperationOutcome } from "../src/operations/registry.js";
import { FireflyError } from "../src/connectors/firefly.js";
import type { Assistant, Conversation, Stored } from "../src/domain/types.js";

/** What `thingstore.search` and `thingstore.get` return per row. */
interface SearchRow {
    thingId: string;
    model: string;
    fields: Record<string, unknown>;
}

/**
 * The Operation names from ACCOUNTING.md's "must provide" table, read from the document itself.
 *
 * Reading the spec rather than restating it is the point: a copy would drift, and then the test
 * would be about the copy. An Operation the document lists as **deferred** is excluded, so
 * deferring one is a deliberate documented act rather than a silent omission.
 */
function requiredBookkeepingOperations(): string[] {
    const document = readFileSync(
        new URL("../../specs/research/ACCOUNTING.md", import.meta.url).pathname,
        "utf8",
    );
    const section = document.slice(
        document.indexOf("## Operations the BookKeeping system must provide"),
    );
    const table = section.slice(0, section.indexOf("\n## ", 1));
    const names: string[] = [];
    for (const line of table.split("\n")) {
        if (!line.startsWith("|")) continue;
        const match = /^\|\s*`([A-Za-z]+)\(/.exec(line);
        if (!match) continue;
        if (/\bdeferred\b/i.test(line)) continue;
        names.push(match[1]!);
    }
    return names;
}

/** Call one Operation the way the loop would, without needing a scripted model. */
async function call(
    harness: Harness,
    operation: string,
    args: Record<string, unknown>,
    overrides: Partial<OperationContext> = {},
): Promise<OperationOutcome> {
    const assistant = await harness.seedAssistant();
    const docRef = await harness.birth({ assistant });
    const conversation = await harness.conversation(docRef);
    const granted = harness.registry.get(operation);
    if (!granted) throw new Error(`No Operation named `);
    return granted.execute(args, {
        conversation: conversation as Stored<Conversation>,
        assistant: assistant as Stored<Assistant>,
        idempotencyKey: `${conversation.thingId}:1`,
        ...overrides,
    });
}

describe("the Operations ACCOUNTING.md requires", () => {
    it("registers every Bookkeeping Operation the document says must be provided", async () => {
        // ACCOUNTING.md is the specification for the Bookkeeping Authority, and five of the ten
        // Operations it names as required had no Operation at all — `listTransactions` existing on
        // the connector and never being registered, so no Assistant could reach it, which is also
        // why the Accountant cannot check its own past bookings.
        //
        // Read from the document rather than from a copy of it, so the two cannot drift: whichever
        // is wrong, this test says so.
        const required = requiredBookkeepingOperations();
        expect(required.length).toBeGreaterThan(0);

        const harness = buildHarness([]);
        const registered = new Set(
            [...required, "x"].filter((name) => harness.registry.get(`bookkeeping.${name}`)),
        );
        const missing = required.filter((name) => !registered.has(name));
        expect(missing).toEqual([]);
    });
});

describe("thingstore.update", () => {
    /** The Process a Receptionist would have built up over several Turns. */
    async function processWithThreeSteps(harness: Harness): Promise<string> {
        const created = await harness.things.create(SPECS.Process_DM, {
            title: "Dr Meyer, July",
            status: "open",
            steps: [
                { seq: 1, title: "Received", state: "done", note: "came in by post" },
                { seq: 2, title: "Checked", state: "done", note: "amount matches the quote" },
                { seq: 3, title: "Booked", state: "doing" },
            ],
            related: [{ thingId: "abc", model: "Invoice_DM", note: "the invoice" }],
            idempotencyKey: "process-with-steps",
        });
        return created.thingId;
    }

    async function stepsOf(harness: Harness, thingId: string) {
        const read = await harness.things.get<Record<string, unknown>>(
            SPECS.Process_DM,
            `Process_DM/${thingId}`,
        );
        return read.data as { steps?: Array<{ seq?: number; state?: string }>; related?: unknown[] };
    }

    it("adds a step without discarding the ones already there", async () => {
        // README calls the Process "the routing slip — a title, a status and an append-only list of
        // steps", and the Operation promises "supply only the fields you are changing; the others are
        // preserved". That held for scalars and was false for a repeating group: the supplied array
        // replaced the whole group, so the obvious move — "add step 4" — destroyed steps 1 to 3 and
        // reported `updated: true`.
        const harness = buildHarness([]);
        const thingId = await processWithThreeSteps(harness);

        const outcome = await call(harness, "thingstore.update", {
            model: "Process_DM",
            thingId,
            fields: { steps: [{ seq: 4, title: "Paid", state: "done" }] },
        });

        expect(outcome.kind).toBe("value");
        const after = await stepsOf(harness, thingId);
        expect((after.steps ?? []).map((step) => step.seq)).toEqual([1, 2, 3, 4]);
        // And a group the update did not mention is untouched.
        expect(after.related).toHaveLength(1);
    });

    it("corrects a step in place rather than appending a second one with the same seq", async () => {
        const harness = buildHarness([]);
        const thingId = await processWithThreeSteps(harness);

        await call(harness, "thingstore.update", {
            model: "Process_DM",
            thingId,
            fields: { steps: [{ seq: 3, title: "Booked", state: "done" }] },
        });

        const after = await stepsOf(harness, thingId);
        expect((after.steps ?? []).map((step) => step.seq)).toEqual([1, 2, 3]);
        expect((after.steps ?? []).find((step) => step.seq === 3)?.state).toBe("done");
    });

    it("does not duplicate rows when the model sends the whole list back", async () => {
        // The realistic failure of a plain append: a model reads the Process, adds a step, and sends
        // all four. Merging by `seq` is what makes both that and "just the new one" correct.
        const harness = buildHarness([]);
        const thingId = await processWithThreeSteps(harness);

        await call(harness, "thingstore.update", {
            model: "Process_DM",
            thingId,
            fields: {
                steps: [
                    { seq: 1, title: "Received", state: "done" },
                    { seq: 2, title: "Checked", state: "done" },
                    { seq: 3, title: "Booked", state: "done" },
                    { seq: 4, title: "Paid", state: "done" },
                ],
            },
        });

        const after = await stepsOf(harness, thingId);
        expect((after.steps ?? []).map((step) => step.seq)).toEqual([1, 2, 3, 4]);
    });

    it("changes only the fields it was given, even if the Thing moves underneath it", async () => {
        // The Operation's own promise is "supply only the fields you are changing; the others are
        // preserved". It read the Thing and wrote the whole snapshot back, which preserves the other
        // fields *as they were when it read* — so anything the User saved in between is reverted.
        // Redundant as well as harmful: `ThingRepository.update` already merges over the current
        // document, so sending the supplied fields alone is both safer and closer to the promise.
        const harness = buildHarness([]);
        const created = await harness.things.create(SPECS.Party_DM, {
            name: "Praxis Dr. Meyer",
            kind: "organisation",
            city: "Köln",
            idempotencyKey: "party-moving-underneath",
        });

        // The User's save lands after the Operation has read the Thing and before it writes.
        const getDocument = harness.store.getDocument.bind(harness.store);
        let edited = false;
        harness.store.getDocument = async (docRef) => {
            const result = await getDocument(docRef);
            // The Operation's own read of *this* Party, not whatever else the harness reads first.
            if (!edited && docRef === created.docRef) {
                edited = true;
                const row = harness.store.rows.get(docRef)!;
                (row.document["Party"] as Record<string, unknown>)["City"] = "Frechen";
            }
            return result;
        };

        await call(harness, "thingstore.update", {
            model: "Party_DM",
            thingId: created.thingId,
            fields: { name: "Praxis Dr. Meyer & Kollegen" },
        });

        const after = await harness.things.get<Record<string, unknown>>(
            SPECS.Party_DM,
            created.docRef,
        );
        expect(edited).toBe(true);
        expect(after.data["name"]).toBe("Praxis Dr. Meyer & Kollegen");
        expect(after.data["city"]).toBe("Frechen");
    });

    it("leaves the group alone when the update supplies an empty array", async () => {
        // `steps: []` silently wiped the group. An empty array is not an instruction to forget.
        const harness = buildHarness([]);
        const thingId = await processWithThreeSteps(harness);

        await call(harness, "thingstore.update", {
            model: "Process_DM",
            thingId,
            fields: { steps: [] },
        });

        const after = await stepsOf(harness, thingId);
        expect((after.steps ?? []).map((step) => step.seq)).toEqual([1, 2, 3]);
    });

    it("does not let a model overwrite the machine fields it names in an update", async () => {
        // BUG-03: `create` overrides idempotencyKey / createdByConversationId after its spread;
        // `update` spread the model's fields verbatim, so an Assistant could rewrite a Thing's dedup
        // and provenance anchors — which crash recovery keys off — just by naming the field.
        const harness = buildHarness([]);
        const thingId = await processWithThreeSteps(harness);
        const before = await harness.things.get<Record<string, unknown>>(SPECS.Process_DM, `Process_DM/${thingId}`);

        const outcome = await call(harness, "thingstore.update", {
            model: "Process_DM",
            thingId,
            fields: {
                status: "done",
                idempotencyKey: "hijacked:9",
                createdByConversationId: "someone-else",
                createdAt: "1999-01-01T00:00:00",
            },
        });

        expect(outcome.kind).toBe("value");
        const after = await harness.things.get<Record<string, unknown>>(SPECS.Process_DM, `Process_DM/${thingId}`);
        expect(after.data.idempotencyKey, "the dedup anchor is unchanged").toBe("process-with-steps");
        expect(after.data.createdByConversationId ?? "").not.toBe("someone-else");
        expect(String(after.data.createdAt ?? "")).toBe(String(before.data.createdAt ?? ""));
        // The one field it was allowed to change did change.
        expect(after.data.status).toBe("done");
    });
});

describe("the idempotency key creation is keyed on", () => {
    it("deduplicates a sequential retry under the same key", async () => {
        const harness = buildHarness([]);
        const key = "party:dr-meyer";
        const first = await harness.things.create(SPECS.Party_DM, { name: "Dr Meyer", idempotencyKey: key });
        const second = await harness.things.create(SPECS.Party_DM, { name: "Dr Meyer", idempotencyKey: key });

        expect(second.thingId).toBe(first.thingId);
        expect(await harness.things.search(SPECS.Party_DM, undefined, 100)).toHaveLength(1);
    });

    it("refuses a blank key instead of silently switching deduplication off", async () => {
        // `if (data.idempotencyKey)` treats "" as "no key", so a caller that computed a blank one got
        // no deduplication and no warning — on the exact code path that exists to make a retried Turn
        // safe. Omitting the field is a legitimate "I have no key"; supplying an empty one is a bug in
        // the caller, and it should say so rather than quietly do the unsafe thing.
        const harness = buildHarness([]);
        await expect(
            harness.things.create(SPECS.Party_DM, { name: "Blank", idempotencyKey: "   " }),
        ).rejects.toThrow(/idempotency key/i);
    });

    it("refuses a key longer than the store can search for", async () => {
        // A key over 100 characters fails inside the *lookup query* rather than being caught — the
        // least debuggable place for it, because the failure names `exact_match` and not the key.
        const harness = buildHarness([]);
        await expect(
            harness.things.create(SPECS.Party_DM, { name: "Long", idempotencyKey: "k".repeat(150) }),
        ).rejects.toThrow(/100/);
    });

    it("converges on one Thing when two callers race under one key", async () => {
        // Search-then-create with nothing atomic between them, and A12 has no unique index. Latent
        // today (one Runtime replica, and a lease serialises a Conversation's Turns) but it is the
        // guarantee ADR-0012 and every `reconcile` lean on, so it should not silently be false.
        const harness = buildHarness([]);
        const key = "party:raced";
        const [a, b] = await Promise.all([
            harness.things.create(SPECS.Party_DM, { name: "Raced", idempotencyKey: key }),
            harness.things.create(SPECS.Party_DM, { name: "Raced", idempotencyKey: key }),
        ]);

        // Both callers end up referring to the same Thing, whichever of them won.
        expect(b.thingId).toBe(a.thingId);
    });
});

describe("bookkeeping.postTransaction", () => {
    it("names the field and the account the model used when Firefly refuses", async () => {
        // `FireflyError.details` carries per-field reasons and nothing ever read them, so what
        // survived was Firefly's first sentence — which talks in *internal Firefly account ids*.
        // The model only ever handled names: `bookkeeping.listAccounts` returns names, and the
        // connector resolves them to ids on the way out. So it was told a number it had never seen,
        // about a field it was not told the name of.
        const harness = buildHarness([]);
        harness.firefly.failNextPost = new FireflyError(
            '[a] Could not find a valid source account when searching for ID "5" or name "". (and 1 more error)',
            422,
            {
                errors: {
                    "transactions.0.source_id": [
                        '[a] Could not find a valid source account when searching for ID "5" or name "".',
                    ],
                },
            },
        );

        const outcome = await call(harness, "bookkeeping.postTransaction", {
            splits: [
                {
                    type: "withdrawal",
                    date: "2026-08-01",
                    amount: "96.50",
                    description: "Consultation",
                    sourceAccount: "Expenses:Health",
                    destinationAccount: "Checking",
                },
            ],
        });

        expect(outcome.kind).toBe("error");
        const message = outcome.kind === "error" ? outcome.message : "";
        // The field, in the vocabulary the model was given.
        expect(message).toMatch(/sourceAccount/);
        // The account it actually named...
        expect(message).toContain("Expenses:Health");
        // ...and not an internal id it was never shown.
        expect(message).not.toMatch(/ID "\d+"/);
    });

    it("still reports a failure with no per-field details", async () => {
        const harness = buildHarness([]);
        harness.firefly.failNextPost = new FireflyError("Firefly HTTP 500", 500, undefined);

        const outcome = await call(harness, "bookkeeping.postTransaction", {
            splits: [
                {
                    type: "withdrawal",
                    date: "2026-08-01",
                    amount: "1.00",
                    description: "x",
                    sourceAccount: "Checking",
                    destinationAccount: "Expenses:Health",
                },
            ],
        });

        expect(outcome.kind).toBe("error");
        expect(outcome.kind === "error" && outcome.message).toContain("Firefly HTTP 500");
    });
});

describe("thingstore.search", () => {
    it("refuses a field with no value in its own words, rather than throwing", async () => {
        // `value` is optional in the Operation's own schema, so a model omitting it makes a *permitted*
        // call. Building `exact_match` with an empty value is not "no filter" — against the live
        // store it produces malformed JSON in the generated predicate and comes back as a bare
        // -32057 whose `data.description` is only "Unexpected error during query execution.", so
        // even a better error channel would leave the model none the wiser. The Operation has to guard.
        const harness = buildHarness([]);
        const outcome = await call(harness, "thingstore.search", {
            model: "Invoice_DM",
            field: "issuerName",
        });

        expect(outcome.kind).toBe("error");
        expect(outcome.kind === "error" && outcome.message).toMatch(/value/i);
    });

    it("refuses an explicitly empty value too", async () => {
        const harness = buildHarness([]);
        const outcome = await call(harness, "thingstore.search", {
            model: "Invoice_DM",
            field: "issuerName",
            value: "",
        });

        expect(outcome.kind).toBe("error");
    });

    it("returns the most recent Things, as its own description promises", async () => {
        // The description says "Without a field filter it returns the most recent ones". It never
        // sorted, so the page was whatever the store felt like returning: measured against the live
        // store as 03,02,08,10,07 out of twelve — not the newest five, not the oldest five, not even
        // a contiguous run. An Assistant asked "what came in recently" got arbitrary rows, and one
        // looking for a specific invoice among more than `limit` matches concluded it did not exist.
        const harness = buildHarness([]);
        const t0 = Date.now() - 3_600_000;
        for (let index = 0; index < 6; index += 1) {
            await harness.things.create(SPECS.Invoice_DM, {
                invoiceNumber: `SORTED-${index}`,
                issuerName: "Clinic",
                createdAt: nowIso(new Date(t0 + index * 60_000)),
                idempotencyKey: `sorted-${index}`,
            });
        }

        const outcome = await call(harness, "thingstore.search", { model: "Invoice_DM", limit: 3 });

        expect(outcome.kind).toBe("value");
        const numbers = (outcome.kind === "value" ? (outcome.value as SearchRow[]) : []).map(
            (row) => row.fields.invoiceNumber,
        );
        expect(numbers).toEqual(["SORTED-5", "SORTED-4", "SORTED-3"]);
    });

    it("refuses a limit it could not honour rather than silently truncating", async () => {
        // `limit: 1000` was clamped to 100 with no signal, so a model that asked for everything and
        // got a hundred rows had no way to know it had not seen everything. (The store refuses
        // pageSize 101 outright, so 100 really is the ceiling — the clamp was ours.)
        const harness = buildHarness([]);
        const outcome = await call(harness, "thingstore.search", { model: "Invoice_DM", limit: 1000 });

        expect(outcome.kind).toBe("error");
        expect(outcome.kind === "error" && outcome.message).toMatch(/100/);
    });

    it("still lists Things when no field is named at all", async () => {
        const harness = buildHarness([]);
        await harness.things.create(SPECS.Invoice_DM, {
            invoiceNumber: "NO-FILTER-1",
            idempotencyKey: "no-filter-1",
        });
        const outcome = await call(harness, "thingstore.search", { model: "Invoice_DM" });

        expect(outcome.kind).toBe("value");
        expect(outcome.kind === "value" && (outcome.value as unknown[]).length).toBeGreaterThan(0);
    });

    it("clamps a negative or fractional limit to a valid page size", async () => {
        // BUG-04: `Number(limit) || 25` only caught falsy values, so `-5` and `3.7` reached the store
        // as pageSize and came back an opaque RPC error the model could not act on.
        const harness = buildHarness([]);
        await harness.things.create(SPECS.Invoice_DM, { invoiceNumber: "L-1", idempotencyKey: "l-1" });

        for (const limit of [-5, 0, 3.7]) {
            const outcome = await call(harness, "thingstore.search", { model: "Invoice_DM", limit });
            expect(outcome.kind, `limit ${limit} is coerced, not a store error`).toBe("value");
        }
    });
});

describe("ui.askUser", () => {
    it("refuses a kind outside its enum, including the connectors' perform surface", async () => {
        // BUG-05: the enum was cast, not enforced, and raiseQuestion also accepts "perform" — the
        // surface reserved for granted manual connectors. An Assistant could mint one just by naming
        // the kind.
        const harness = buildHarness([]);
        for (const kind of ["perform", "nonsense"]) {
            const outcome = await call(harness, "ui.askUser", { kind, prompt: "please" });
            expect(outcome.kind, `kind ${kind}`).toBe("error");
        }
    });

    it("still raises an ordinary confirm question", async () => {
        const harness = buildHarness([]);
        const outcome = await call(harness, "ui.askUser", { kind: "confirm", prompt: "ok?" });
        expect(outcome.kind).toBe("pending");
    });
});

/**
 * The two allow-lists, which are the whole of what an Assistant may reach through the ThingStore.
 *
 * `READABLE_MODELS` was declared and referenced nowhere until this change, so "an Assistant may
 * read its own machinery but never write it" was a comment rather than a guard. It is a guard now,
 * and the catalogue is the one Model it withholds: it is the safety configuration constraining the
 * reader, and ADR-0010's design is that an Assistant learns what it may do from the schemas it is
 * offered rather than by reading about them.
 */
describe("the Models an Assistant may read and write", () => {
    const readable = Object.keys(SPECS).filter((model) => model !== "Operation_DM");

    it("refuses to read one Operation, and says what it may read instead", async () => {
        const harness = buildHarness([]);
        const outcome = await call(harness, "thingstore.get", {
            model: "Operation_DM",
            thingId: "whatever",
        });

        expect(outcome.kind).toBe("error");
        const message = outcome.kind === "error" ? outcome.message : "";
        expect(message).toContain("may not read Operation_DM");
        for (const model of readable) expect(message).toContain(model);
    });

    it("refuses to search the catalogue too, not merely to get one row of it", async () => {
        const harness = buildHarness([]);
        const outcome = await call(harness, "thingstore.search", { model: "Operation_DM" });

        expect(outcome.kind).toBe("error");
        const message = outcome.kind === "error" ? outcome.message : "";
        expect(message).toContain("may not read Operation_DM");
        expect(message).toContain("Invoice_DM");
    });

    it("still reads every other Model", async () => {
        const harness = buildHarness([]);
        for (const model of readable) {
            const outcome = await call(harness, "thingstore.search", { model, limit: 1 });
            expect([model, outcome.kind]).toEqual([model, "value"]);
        }
    });

    it("refuses to update an Operation, naming the Models it may write", async () => {
        const harness = buildHarness([]);
        const outcome = await call(harness, "thingstore.update", {
            model: "Operation_DM",
            thingId: "whatever",
            fields: { enabled: true },
        });

        expect(outcome.kind).toBe("error");
        const message = outcome.kind === "error" ? outcome.message : "";
        expect(message).toContain("may not update Operation_DM");
        expect(message).toContain("Party_DM, Document_DM, Invoice_DM, Process_DM");
    });
});
