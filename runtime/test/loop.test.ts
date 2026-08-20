/**
 * The loop driver's branching.
 *
 * These are the behaviours the ADRs assert and nothing else verifies: that an Assistant which
 * asks a question holds nothing in memory, that continuation is re-entry rather than a second
 * mechanism, and that recovering a crashed Turn does not do the work twice.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
    buildHarness,
    clearCatalogue,
    nowIso,
    putCatalogue,
    useFirefly,
    type Harness,
} from "./support/harness.js";
import { FireflyFixture } from "./support/fireflyFixture.js";
import { eq, path as fieldPath, SPECS } from "../src/a12/things.js";
import {
    buildMessages,
    canonicalArgsHash,
    ENTRY_HEADROOM,
    isFull,
    MAX_ENTRIES,
} from "../src/loop/advance.js";
import { A12RpcError } from "../src/a12/client.js";
import { FireflyError } from "../src/connectors/firefly.js";
import type { Conversation, OpenQuestion, Operation, Stored } from "../src/domain/types.js";

/** Edit one Operation Thing, the way the User would in the web application. */
async function editOperation(
    harness: Harness,
    key: string,
    patch: Partial<Operation>,
): Promise<void> {
    const [thing] = await harness.things.search<Operation>(
        SPECS.Operation_DM,
        eq(fieldPath(SPECS.Operation_DM, "key"), key),
        2,
    );
    expect(thing, `the catalogue holds ${key}`).toBeDefined();
    await harness.things.update(SPECS.Operation_DM, thing!.docRef, { ...thing!.data, ...patch });
}

/** The posting the approval tests approve, and the recovery test books. */
const POSTING = {
    groupTitle: "Dr Meyer 2026-118",
    thingId: "invoice-1",
    splits: [
        {
            type: "withdrawal",
            date: "2026-08-01",
            amount: "184.30",
            description: "Dr Meyer",
            sourceAccount: "Payables",
            destinationAccount: "Expenses:Health",
        },
    ],
};

/** The one question this Conversation is waiting on. */
async function pendingQuestion(harness: Harness, docRef: string): Promise<Stored<OpenQuestion>> {
    const questionId = (await harness.conversation(docRef)).data.currentQuestionId;
    expect(questionId, "the conversation is waiting on a question").toBeTruthy();
    const found = (await harness.questions()).find((question) => question.thingId === questionId);
    expect(found).toBeDefined();
    return found!;
}

/** Say yes to whatever it is waiting on, and let the watcher resume it. */
async function approve(harness: Harness, docRef: string): Promise<void> {
    const question = await pendingQuestion(harness, docRef);
    await harness.answer(question.thingId, { confirmed: true, answeredAt: "" });
    await harness.watcher.scan();
}

// The approval and recovery tests drive the dynamic bookkeeping Operations (ADR-0025) through the
// Operation Host against this in-process Firefly; the other tests here do not touch it.
const fixture = new FireflyFixture();
beforeAll(() => fixture.start());
afterAll(() => {
    useFirefly(undefined);
    return fixture.stop();
});
beforeEach(() => {
    fixture.reset();
    useFirefly(fixture);
});

describe("one turn", () => {
    it("finishes when the model answers without asking for tools", async () => {
        const harness = buildHarness([{ text: "All done.", finishReason: "answered" }]);
        const assistant = await harness.seedAssistant();
        const docRef = await harness.birth({ assistant });

        const result = await harness.driver.advance(docRef);

        expect(result.status).toBe("done");
        const conversation = await harness.conversation(docRef);
        expect(conversation.data.status).toBe("done");
        expect(conversation.data.result).toBe("All done.");
        expect(conversation.data.turnCount).toBe(1);
        expect(conversation.data.leaseUntil).toBe("");
    });

    it("executes a tool call and keeps going", async () => {
        const harness = buildHarness([
            {
                turn: 0,
                toolCalls: [
                    { name: "thingstore__create", arguments: { model: "Party_DM", fields: { name: "Dr Meyer" } } },
                ],
            },
            { turn: 1, text: "Created the party.", finishReason: "answered" },
        ]);
        const assistant = await harness.seedAssistant();
        const docRef = await harness.birth({ assistant });

        await harness.driver.advance(docRef);
        let conversation = await harness.conversation(docRef);
        expect(conversation.data.status).toBe("running");
        const kinds = (conversation.data.entries ?? []).map((entry) => entry.kind);
        expect(kinds).toContain("tool-intent");
        expect(kinds).toContain("tool-result");

        await harness.driver.advance(docRef);
        conversation = await harness.conversation(docRef);
        expect(conversation.data.status).toBe("done");

        const parties = await harness.things.search(SPECS.Party_DM, undefined, 10);
        expect(parties).toHaveLength(1);
    });

    it("writes the intent before the tool runs, so a crash leaves a record of what was attempted", async () => {
        const harness = buildHarness([
            {
                turn: 0,
                toolCalls: [{ name: "thingstore__create", arguments: { model: "Party_DM", fields: { name: "X" } } }],
            },
        ]);
        const assistant = await harness.seedAssistant();
        const docRef = await harness.birth({ assistant });
        await harness.driver.advance(docRef);

        // The conversation was written between appending the intent and creating the Party.
        const conversationWrites = harness.store.writes.filter((write) => write.docRef === docRef);
        const partyCreate = harness.store.writes.findIndex(
            (write) => write.method === "ADD_DOCUMENT" && write.docRef.startsWith("Party_DM/"),
        );
        const firstConversationWrite = harness.store.writes.findIndex(
            (write) => write.method === "MODIFY_DOCUMENT" && write.docRef === docRef,
        );
        expect(conversationWrites.length).toBeGreaterThan(0);
        expect(firstConversationWrite).toBeLessThan(partyCreate);
    });
});

/**
 * The catalogue a Turn resolves against (ADR-0019).
 *
 * One unconstrained read at the top of `advance()`, and no fallback to the seeds: a system that ran
 * on a catalogue nobody configured would be wrong in the one place where the wrong answer costs
 * money.
 */
describe("the catalogue a Turn loads", () => {
    it("throws before the provider is called when the catalogue is empty, and spends no Turn", async () => {
        const harness = buildHarness([{ text: "this must never be reached", finishReason: "answered" }]);
        const assistant = await harness.seedAssistant();
        const docRef = await harness.birth({ assistant });
        clearCatalogue(harness.store);
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});

        await expect(harness.driver.advance(docRef)).rejects.toThrow(/bootstrap/i);

        // At error, with the remedy, so an operator reading the log knows what to run.
        expect(errors.mock.calls.map((call) => String(call[0] ?? "")).join("\n")).toMatch(
            /just bootstrap/,
        );
        errors.mockRestore();

        const conversation = await harness.conversation(docRef);
        // The Turn is not spent against maxTurns, the model was never asked, and the lease never
        // reached the store — so the next scan retries rather than finding it claimed.
        expect(conversation.data.turnCount ?? 0).toBe(0);
        expect(conversation.data.status).toBe("running");
        expect(conversation.data.result).toBeFalsy();
        expect(conversation.data.entries).toHaveLength(1);
        expect(conversation.data.leaseUntil).toBeFalsy();
    });

    it("reads the catalogue once per Turn, whatever the Turn goes on to do", async () => {
        // One snapshot per Turn rather than per call site: a User editing the catalogue mid-Turn
        // must not produce a Turn whose offered schemas and executed Operations disagree.
        const harness = buildHarness([
            {
                turn: 0,
                toolCalls: [
                    { name: "thingstore__search", arguments: { model: "Party_DM" } },
                    { name: "thingstore__search", arguments: { model: "Invoice_DM" } },
                ],
            },
        ]);
        const assistant = await harness.seedAssistant({ grants: [{ operationKey: "thingstore.search" }] });
        const docRef = await harness.birth({ assistant });

        const query = harness.store.query.bind(harness.store);
        let reads = 0;
        harness.store.query = async (spec) => {
            if (spec.targetDocumentModel === "Operation_DM") reads += 1;
            return query(spec);
        };

        await harness.driver.advance(docRef);

        expect(reads).toBe(1);
    });

    it("puts the Turn's prose on the first tool-intent only, not on every call", async () => {
        // BUG-07: `text: response.text` was written on every intent, so buildMessages replayed the
        // same narration once per call — wasted prompt tokens next Turn, and the User saw it twice.
        const harness = buildHarness([
            {
                turn: 0,
                text: "Let me look up both.",
                toolCalls: [
                    { name: "thingstore__search", arguments: { model: "Party_DM" } },
                    { name: "thingstore__search", arguments: { model: "Invoice_DM" } },
                ],
            },
            { turn: 1, text: "done.", finishReason: "answered" },
        ]);
        const assistant = await harness.seedAssistant({ grants: [{ operationKey: "thingstore.search" }] });
        const docRef = await harness.birth({ assistant });

        await harness.driver.advance(docRef);

        const conversation = await harness.conversation(docRef);
        const intents = (conversation.data.entries ?? []).filter((entry) => entry.kind === "tool-intent");
        expect(intents).toHaveLength(2);
        expect(intents[0]!.text).toBe("Let me look up both.");
        expect(intents[1]!.text ?? "").toBe("");
    });

    it("resolves the grants once per Turn, so one bad grant is one warning", async () => {
        // `grantedTo` logs every drop, and it used to be called three times in a Turn — once for the
        // schemas, once for the belt check, once by reconciliation — so a single mistyped grant put
        // two or three identical lines in the log per Turn, per Conversation, forever. It is also
        // what architecture.md means by "the schemas offered to the LLM are derived from the same
        // call": one resolution, or the advertised set and the executable set are two answers.
        const harness = buildHarness([
            {
                turn: 0,
                toolCalls: [{ name: "thingstore__get", arguments: { model: "Party_DM", thingId: "p" } }],
            },
        ]);
        const assistant = await harness.seedAssistant({
            grants: [{ operationKey: "thingstore.get" }, { operationKey: "email.snd" }],
        });
        const docRef = await harness.birth({ assistant });
        const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

        await harness.driver.advance(docRef);

        const dropped = warnings.mock.calls
            .map((call) => call.map(String).join(" "))
            .filter((line) => line.includes("a granted Operation was dropped"));
        warnings.mockRestore();
        expect(dropped).toHaveLength(1);
        expect(dropped[0]).toContain("email.snd");
    });

    it("says so when the catalogue fills a whole page, rather than truncating in silence", async () => {
        // One page, and the store promises no order — so past the ceiling a Turn sees an arbitrary
        // subset, and a grant naming one of the missing Operations is dropped as `absent`, which
        // tells the model it does not exist.
        const harness = buildHarness([{ text: "done.", finishReason: "answered" }]);
        putCatalogue(
            harness.store,
            Array.from({ length: 100 - harness.catalogue.length }, (_, index) => ({
                key: `filler.${index}`,
                name: `Filler ${index}`,
                system: "Runtime",
                kind: "internal" as const,
                description: "Created by hand.",
                parameters: "{}",
                mutating: false,
                enabled: true,
            })),
        );
        const assistant = await harness.seedAssistant();
        const docRef = await harness.birth({ assistant });
        const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

        await harness.driver.advance(docRef);

        const lines = warnings.mock.calls.map((call) => call.map(String).join(" "));
        warnings.mockRestore();
        expect(lines.join("\n")).toMatch(/whole page/);
    });
});

describe("a Conversation with no room left to record anything (B-29)", () => {
    /** Fill a Conversation's Entries to `count`, the way a long-running one fills them. */
    async function fillEntries(harness: Harness, docRef: string, count: number): Promise<void> {
        const stored = await harness.conversation(docRef);
        const entries = stored.data.entries ?? [];
        const padding = Array.from({ length: count - entries.length }, (_unused, index) => ({
            seq: entries.length + index + 1,
            at: "2026-08-18T12:00:00",
            role: "assistant" as const,
            kind: "response" as const,
            text: `filler ${index}`,
        }));
        await harness.things.update(SPECS.Conversation_DM, docRef, {
            ...stored.data,
            entries: [...entries, ...padding],
        });
    }

    it("stops and says why, rather than writing an entry the store will refuse", async () => {
        const harness = buildHarness([{ text: "should never run", finishReason: "answered" }]);
        const assistant = await harness.seedAssistant();
        const docRef = await harness.birth({ assistant });
        // One past the boundary: fewer than ENTRY_HEADROOM rows remain, so no Turn may start.
        await fillEntries(harness, docRef, MAX_ENTRIES - ENTRY_HEADROOM + 1);

        const result = await harness.driver.advance(docRef);

        expect(result.status).toBe("failed");
        const conversation = await harness.conversation(docRef);
        expect(conversation.data.status).toBe("failed");
        expect(conversation.data.finishReason).toBe("limit");
        expect(conversation.data.leaseUntil).toBe("");
        // Nothing ends silently (ADR-0015): the reason is on the Conversation and in the transcript.
        expect(conversation.data.lastError).toMatch(/filled up/);
        expect((conversation.data.entries ?? []).at(-1)?.kind).toBe("error");
        // And it stayed inside the Model's limit while saying so.
        expect((conversation.data.entries ?? []).length).toBeLessThanOrEqual(MAX_ENTRIES);
    });

    it("recovers a Conversation that was already at the limit before the guard existed", async () => {
        // The wedged case: exactly MAX_ENTRIES rows, so not one more can be appended. It must still
        // end — previously it could not be written at all, so it stayed runnable and the scan retried
        // it every few seconds for ever.
        const harness = buildHarness([{ text: "should never run", finishReason: "answered" }]);
        const assistant = await harness.seedAssistant();
        const docRef = await harness.birth({ assistant });
        await fillEntries(harness, docRef, MAX_ENTRIES);

        const result = await harness.driver.advance(docRef);

        expect(result.status).toBe("failed");
        const conversation = await harness.conversation(docRef);
        expect(conversation.data.status).toBe("failed");
        expect(conversation.data.lastError).toMatch(/filled up/);
        // No epitaph, because there was no row to put it in — and crucially, no attempt to add one.
        expect((conversation.data.entries ?? []).length).toBe(MAX_ENTRIES);
    });

    it("leaves a Conversation with room alone", async () => {
        const harness = buildHarness([{ text: "All done.", finishReason: "answered" }]);
        const assistant = await harness.seedAssistant();
        const docRef = await harness.birth({ assistant });
        // Exactly at the boundary: the full headroom is still free, so this one runs. Together with
        // the test above this pins the boundary from both sides rather than approximately.
        await fillEntries(harness, docRef, MAX_ENTRIES - ENTRY_HEADROOM);

        const result = await harness.driver.advance(docRef);

        expect(result.status).toBe("done");
        // The Turn ran, and the rows it wrote fitted inside the Model's limit. That is what the
        // headroom is for: a Turn that starts must be able to finish without overrunning, and this
        // one consumed part of the reserve rather than blowing past 100.
        const after = (await harness.conversation(docRef)).data;
        expect((after.entries ?? []).length).toBeLessThanOrEqual(MAX_ENTRIES);
        // Having spent the headroom, it is now full — so the *next* advance ends it cleanly rather
        // than failing a write.
        expect(isFull(after)).toBe(true);
    });
});

describe("what a failure tells the model", () => {
    it("passes on the store's own reason for a rejection, not a stack trace", async () => {
        // The store gives a precise reason for each of a dozen structurally different mistakes —
        // missing mandatory field, over-length string, unsupported character, three decimals on an
        // amount, a year-1000 date. All of them arrived at the model as the same sentence, because
        // `A12RpcError` is built from `rpcError.message` (always the same generic string) and never
        // touches `rpcError.data`, and because the tool result was `error.stack`.
        //
        // `advance.ts` says the error path is "recoverable by the model: it sees the error as a tool
        // result and self-corrects". It cannot self-correct from "Could not create document"; the
        // likely behaviour is retrying identical input until maxTurns.
        const harness = buildHarness([
            {
                turn: 0,
                toolCalls: [
                    {
                        name: "thingstore__create",
                        arguments: { model: "Party_DM", fields: { name: "Klinik 🏥", kind: "organisation" } },
                    },
                ],
            },
        ]);
        const assistant = await harness.seedAssistant();
        const docRef = await harness.birth({ assistant });

        // Verbatim from the live store, including the code and where the reason actually lives.
        harness.store.failNextAdd = new A12RpcError("ADD_DOCUMENT", {
            code: -32002,
            message: "Could not create document",
            data: {
                description: {
                    default:
                        "Document is not valid:\n[Entity: PartiallyKnownDocumentMultiPointerImpl" +
                        "[/Party/Name, [1, 1]] Type: VALUE_ERROR Message: The field contains one or " +
                        "several unsupported signs. ErrorCode: ZeichenNichtImZeichensatz " +
                        "Rule: formalePruefung]",
                },
            },
        });

        await harness.driver.advance(docRef);

        const conversation = await harness.conversation(docRef);
        const result = (conversation.data.entries ?? []).find((entry) => entry.kind === "tool-result");
        expect(result?.toolResult).toMatch(/unsupported signs|ZeichenNichtImZeichensatz/);
        // No stack frames, and no absolute host paths leaking into an LLM prompt.
        expect(result?.toolResult).not.toMatch(/\n\s+at /);
        expect(result?.toolResult).not.toMatch(/\/Users\//);
    });
});

describe("tool gating (ADR-0010)", () => {
    it("does not offer an Assistant a tool it has not declared", async () => {
        const harness = buildHarness([]);
        const assistant = await harness.seedAssistant({
            grants: [{ operationKey: "thingstore.get" }],
        });
        const schemas = harness.registry.schemasFor(assistant.data, harness.catalogue);
        const names = schemas.map((schema) => schema.name);
        expect(names).toContain("thingstore__get");
        expect(names).not.toContain("bookkeeping__postTransaction");
    });

    it("refuses an undeclared tool even if the model asks for it anyway", async () => {
        const harness = buildHarness([
            {
                turn: 0,
                toolCalls: [{ name: "bookkeeping__postTransaction", arguments: { splits: [] } }],
            },
        ]);
        const assistant = await harness.seedAssistant({ grants: [{ operationKey: "thingstore.get" }] });
        const docRef = await harness.birth({ assistant });
        await harness.driver.advance(docRef);

        const conversation = await harness.conversation(docRef);
        const result = (conversation.data.entries ?? []).find((entry) => entry.kind === "tool-result");
        // Nothing was dropped — this Operation was never granted — so this is the one case where
        // "you do not have it" is the whole truth.
        expect(result?.toolResult).toMatch(/"bookkeeping\.postTransaction" is not granted to you/);
        expect(result?.toolResult).toMatch(/Available: thingstore\.get/);
        expect(harness.firefly.posted).toHaveLength(0);
    });

    /**
     * The belt, and what it says.
     *
     * *"X is not one of your tools"* is **false** for the likeliest case after ADR-0019: the User
     * switched the Operation off, the grant is still in the Assistant's definition where the User
     * can see it, and a model told it never had a capability re-plans around a premise that is not
     * true. So the belt consults the drop reason and says the thing that is.
     */
    describe("what the model is told when a granted Operation resolved to nothing", () => {
        /** One Turn in which the model calls `call`, and the tool-result it was given. */
        async function told(input: {
            grants: string[];
            call: string;
            key?: string;
            edit?: (harness: Harness) => Promise<void>;
        }): Promise<string> {
            const harness = buildHarness([
                { turn: 0, toolCalls: [{ name: input.call, arguments: {} }] },
            ]);
            const assistant = await harness.seedAssistant({
                key: input.key ?? "receptionist",
                grants: input.grants.map((operationKey) => ({ operationKey })),
            });
            await input.edit?.(harness);
            const docRef = await harness.birth({ assistant });
            const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
            await harness.driver.advance(docRef);
            warnings.mockRestore();
            const conversation = await harness.conversation(docRef);
            return (
                (conversation.data.entries ?? []).find((entry) => entry.kind === "tool-result")
                    ?.toolResult ?? ""
            );
        }

        it("says an Operation the User switched off is switched off", async () => {
            const result = await told({
                grants: ["bank.sendMoney"],
                call: "bank__sendMoney",
                edit: (harness) => editOperation(harness, "bank.sendMoney", { enabled: false }),
            });
            expect(result).toMatch(/"bank\.sendMoney" is switched off/);
            expect(result).not.toMatch(/not one of your tools|not granted to you/);
        });

        it("says an Operation with no Implementation is no longer implemented", async () => {
            const result = await told({
                grants: ["email.forward"],
                call: "email__forward",
                // A Thing left behind by an Implementation that was deleted — bootstrap never
                // removes one, because the User may have notes on it.
                edit: async (harness) =>
                    putCatalogue(harness.store, [
                        {
                            key: "email.forward",
                            name: "Forward an email",
                            system: "Email",
                            kind: "connector",
                            description: "Forward an email.",
                            parameters: '{"type":"object","properties":{}}',
                            enabled: true,
                        },
                    ]),
            });
            expect(result).toMatch(/"email\.forward" is no longer implemented/);
        });

        it("says a grant naming nothing in the catalogue names nothing", async () => {
            const result = await told({ grants: ["email.forward"], call: "email__forward" });
            expect(result).toMatch(/"email\.forward" is granted to you, but no such Operation exists/);
        });

        it("says an Operation whose parameters will not parse is misconfigured", async () => {
            const result = await told({
                grants: ["bank.sendMoney"],
                call: "bank__sendMoney",
                edit: (harness) =>
                    editOperation(harness, "bank.sendMoney", { parameters: "{ not json at all" }),
            });
            expect(result).toMatch(/"bank\.sendMoney" is misconfigured/);
            expect(result).toMatch(/not valid JSON/);
        });

        it("says a self-call is a self-call", async () => {
            const result = await told({
                key: "receptionist",
                grants: ["assistant.call:receptionist"],
                call: "assistant__call__receptionist",
            });
            expect(result).toMatch(/"assistant\.call:receptionist" would call yourself/);
        });

        it("says a bare assistant.call needs a callee, rather than pretending it is a wildcard", async () => {
            const result = await told({ grants: ["assistant.call"], call: "assistant__call" });
            expect(result).toMatch(/"assistant\.call" is not a wildcard/);
            expect(result).toMatch(/assistant\.call:<key>/);
        });
    });

    it("rejects an Assistant calling itself", async () => {
        const harness = buildHarness([]);
        const assistant = await harness.seedAssistant({
            key: "receptionist",
            grants: [{ operationKey: "assistant.call:receptionist" }, { operationKey: "assistant.call:accountant" }],
        });
        const callees = harness.registry.calleesOf(assistant.data);
        expect(callees).toEqual(["accountant"]);
    });
});

/**
 * ADR-0018. The rule the whole system's central promise rests on, and the one the end-to-end tier
 * could not prove: it scripts a model that chooses to ask, so it demonstrates suspend-and-resume
 * rather than a Runtime that refuses.
 */
describe("an Operation that requires an approval (ADR-0018)", () => {
    const bookingAssistant = (harness: Harness) =>
        harness.seedAssistant({ grants: [{ operationKey: "bookkeeping.postTransaction" }] });

    it("refuses a booking with no approval at all, and asks the User itself", async () => {
        // The Assistant's prompt says nothing about asking, and it does not ask. Nothing reaches
        // Firefly anyway — which is the whole point: the model is not the thing being trusted.
        const harness = buildHarness([
            { turn: 0, toolCalls: [{ name: "bookkeeping__postTransaction", arguments: POSTING }] },
        ]);
        const assistant = await bookingAssistant(harness);
        const docRef = await harness.birth({ assistant });

        const result = await harness.driver.advance(docRef);

        expect(result.status).toBe("waiting");
        expect(harness.firefly.posted).toHaveLength(0);

        const conversation = await harness.conversation(docRef);
        expect(conversation.data.waitingFor).toBe("user");
        // A missing approval is the ordinary path, not a stuck Conversation: going through
        // `escalate()` would mean three unapproved bookings marked it `failed`.
        expect(conversation.data.escalationCount ?? 0).toBe(0);
        // And it waits rather than lapsing into a booking.
        expect(conversation.data.wakeAt).toBeFalsy();

        const question = await pendingQuestion(harness, docRef);
        expect(question.data.kind).toBe("confirm");
        // bookkeeping.postTransaction carries a synchronous describer (dynamicDescribers), so the
        // approval question reads as a money sentence — `€184.30 from *Payables* to *Expenses:Health*`
        // — not the raw JSON fallback. This is the safety prompt on the one Operation that moves money.
        expect(question.data.prompt).toContain("Approval needed");
        expect(question.data.prompt).toContain("€184.30");
        expect(question.data.prompt).toContain("Payables");
        expect(question.data.prompt).toContain("Expenses:Health");
        expect(question.data.prompt).toContain("2026-08-01");
        expect(question.data.prompt).not.toContain("```json");

        // The refusal is visible in the transcript, and says it is not queued.
        const entries = conversation.data.entries ?? [];
        const request = entries.find((entry) => entry.kind === "approval-request");
        expect(request?.toolName).toBe("bookkeeping.postTransaction");
        expect(request?.questionId).toBe(question.thingId);
        expect(request?.argsHash).toBe(canonicalArgsHash(POSTING));
        // No `text`, deliberately: it must not become a message between a tool call and its result.
        expect(request?.text).toBeFalsy();
        const pending = entries.find((entry) => entry.kind === "tool-result");
        expect(pending?.toolResult).toMatch(/not queued/i);
    });

    it("books it once the User says yes, on the second identical call", async () => {
        const harness = buildHarness([
            { turn: 0, toolCalls: [{ name: "bookkeeping__postTransaction", arguments: POSTING }] },
            { turn: 1, toolCalls: [{ name: "bookkeeping__postTransaction", arguments: POSTING }] },
            { turn: 2, text: "Booked.", finishReason: "answered" },
        ]);
        const assistant = await bookingAssistant(harness);
        const docRef = await harness.birth({ assistant });

        await harness.driver.advance(docRef);
        await approve(harness, docRef);

        expect(harness.firefly.posted).toHaveLength(1);
        expect(harness.firefly.posted[0]!.amount).toBe("184.30");

        await harness.watcher.scan();
        expect((await harness.conversation(docRef)).data.status).toBe("done");
    });

    it("does not count a question the Assistant asked for itself", async () => {
        // The unsound first draft: a model that asks "shall I file this under Renovation?", is told
        // yes, and then books whatever it likes would have been authorised by a yes about something
        // else. A question the Assistant composed cannot be the thing that constrains it.
        const harness = buildHarness([
            {
                turn: 0,
                toolCalls: [
                    {
                        name: "ui__askUser",
                        arguments: { kind: "confirm", prompt: "Shall I file this under Renovation?" },
                    },
                ],
            },
            { turn: 1, toolCalls: [{ name: "bookkeeping__postTransaction", arguments: POSTING }] },
        ]);
        const assistant = await harness.seedAssistant({
            grants: [{ operationKey: "ui.askUser" }, { operationKey: "bookkeeping.postTransaction" }],
        });
        const docRef = await harness.birth({ assistant });

        await harness.driver.advance(docRef);
        const asked = await pendingQuestion(harness, docRef);
        await harness.answer(asked.thingId, { confirmed: true, text: "Yes, Renovation." });
        await harness.watcher.scan();

        expect(harness.firefly.posted).toHaveLength(0);
        // A second question was raised — by the Runtime this time, about the booking itself.
        const raised = await pendingQuestion(harness, docRef);
        expect(raised.thingId).not.toBe(asked.thingId);
        expect(raised.data.prompt).toContain("Approval needed");
    });

    it("declines terminally on a no, and raises nothing further", async () => {
        const harness = buildHarness([
            { turn: 0, toolCalls: [{ name: "bookkeeping__postTransaction", arguments: POSTING }] },
            { turn: 1, toolCalls: [{ name: "bookkeeping__postTransaction", arguments: POSTING }] },
            { turn: 2, text: "Understood, leaving it unbooked.", finishReason: "answered" },
        ]);
        const assistant = await bookingAssistant(harness);
        const docRef = await harness.birth({ assistant });

        await harness.driver.advance(docRef);
        const question = await pendingQuestion(harness, docRef);
        await harness.answer(question.thingId, { confirmed: false, answeredAt: "" });
        await harness.watcher.scan();

        expect(harness.firefly.posted).toHaveLength(0);
        // One question, still. Re-asking a User who has said no is how a safety feature becomes a
        // thing people click through.
        expect(await harness.questions()).toHaveLength(1);

        const conversation = await harness.conversation(docRef);
        const errors = (conversation.data.entries ?? []).filter(
            (entry) => entry.kind === "tool-result" && entry.toolResult?.includes("declined"),
        );
        expect(errors).toHaveLength(1);
        expect(conversation.data.status).not.toBe("waiting");
    });

    it("treats an answer with no explicit yes as a no", async () => {
        // `isAnswered` is generous — nothing stamps `answeredAt`, so any filled answer field counts
        // and the watcher resumes on that basis. Anything short of an explicit tick therefore has to
        // be a no, or the Conversation would refuse and resume in a loop until maxTurns.
        const harness = buildHarness([
            { turn: 0, toolCalls: [{ name: "bookkeeping__postTransaction", arguments: POSTING }] },
            { turn: 1, toolCalls: [{ name: "bookkeeping__postTransaction", arguments: POSTING }] },
            { turn: 2, text: "Not booked.", finishReason: "answered" },
        ]);
        const assistant = await bookingAssistant(harness);
        const docRef = await harness.birth({ assistant });

        await harness.driver.advance(docRef);
        const question = await pendingQuestion(harness, docRef);
        await harness.answer(question.thingId, { text: "I need to check with the insurer first." });
        await harness.watcher.scan();

        expect(harness.firefly.posted).toHaveLength(0);
        expect(await harness.questions()).toHaveLength(1);
        const results = (await harness.conversation(docRef)).data.entries ?? [];
        expect(
            results.some(
                (entry) =>
                    entry.kind === "tool-result" && /answered without confirming/i.test(entry.toolResult ?? ""),
            ),
        ).toBe(true);
    });

    it("needs a second approval for a second identical booking", async () => {
        // One yes must not place the same transaction twice under two idempotency keys, which is
        // what ADR-0012 exists to prevent.
        const harness = buildHarness([
            { turn: 0, toolCalls: [{ name: "bookkeeping__postTransaction", arguments: POSTING }] },
            { turn: 1, toolCalls: [{ name: "bookkeeping__postTransaction", arguments: POSTING }] },
            { turn: 2, toolCalls: [{ name: "bookkeeping__postTransaction", arguments: POSTING }] },
        ]);
        const assistant = await bookingAssistant(harness);
        const docRef = await harness.birth({ assistant });

        await harness.driver.advance(docRef);
        await approve(harness, docRef);
        expect(harness.firefly.posted).toHaveLength(1);

        // Turn 2 asks for the very same booking again, and is refused: the approval is spent.
        await harness.watcher.scan();
        const conversation = await harness.conversation(docRef);
        expect(conversation.data.status).toBe("waiting");
        expect(conversation.data.waitingFor).toBe("user");
        const requests = (conversation.data.entries ?? []).filter(
            (entry) => entry.kind === "approval-request",
        );
        expect(requests).toHaveLength(2);
        expect(requests[0]!.questionId).not.toBe(requests[1]!.questionId);
        expect(harness.firefly.posted).toHaveLength(1);
    });

    it("keeps the approval when the booking was refused by the books, so a retry needs no second yes", async () => {
        // The path the first version of this got wrong. Every rejection is recorded as a tool-result
        // for the Operation, so "any tool-result after the answer" counted a Firefly 422 — after which
        // nothing was booked at all — as having spent the approval. The model then retried the
        // identical call, exactly as `postTransaction`'s own description invites, and the User was
        // asked a second time for a booking that never happened.
        const harness = buildHarness([
            { turn: 0, toolCalls: [{ name: "bookkeeping__postTransaction", arguments: POSTING }] },
            { turn: 1, toolCalls: [{ name: "bookkeeping__postTransaction", arguments: POSTING }] },
            { turn: 2, toolCalls: [{ name: "bookkeeping__postTransaction", arguments: POSTING }] },
            { turn: 3, text: "Booked on the retry.", finishReason: "answered" },
        ]);
        const assistant = await bookingAssistant(harness);
        const docRef = await harness.birth({ assistant });

        // Firefly refuses the first attempt, the way it refuses an unknown account.
        harness.firefly.failNextPost = new FireflyError("Firefly refused this posting.", 422, {
            errors: { "transactions.0.source_id": ["Invalid account."] },
        });

        await harness.driver.advance(docRef);
        await approve(harness, docRef);

        // Nothing booked, and the model was told why.
        expect(harness.firefly.posted).toHaveLength(0);
        const afterRejection = await harness.conversation(docRef);
        expect(
            (afterRejection.data.entries ?? []).some((entry) =>
                /Firefly refused/i.test(entry.toolResult ?? ""),
            ),
        ).toBe(true);

        // The retry goes through on the SAME approval: one question, and the booking lands.
        await harness.watcher.scan();
        expect(harness.firefly.posted).toHaveLength(1);
        expect(await harness.questions()).toHaveLength(1);

        const finished = await harness.conversation(docRef);
        expect(
            (finished.data.entries ?? []).filter((entry) => entry.kind === "approval-request"),
        ).toHaveLength(1);
        // And the successful result is the one carrying the hash — that is what "spent" now means.
        const spent = (finished.data.entries ?? []).filter(
            (entry) => entry.kind === "tool-result" && entry.argsHash === canonicalArgsHash(POSTING),
        );
        expect(spent).toHaveLength(1);
        expect(spent[0]!.toolResult).toContain("transactionId");
    });

    it("asks again rather than booking when the arguments drifted after the yes", async () => {
        const drifted = {
            ...POSTING,
            splits: [{ ...POSTING.splits[0]!, amount: "185.00" }],
        };
        const harness = buildHarness([
            { turn: 0, toolCalls: [{ name: "bookkeeping__postTransaction", arguments: POSTING }] },
            { turn: 1, toolCalls: [{ name: "bookkeeping__postTransaction", arguments: drifted }] },
        ]);
        const assistant = await bookingAssistant(harness);
        const docRef = await harness.birth({ assistant });

        await harness.driver.advance(docRef);
        await approve(harness, docRef);

        expect(harness.firefly.posted).toHaveLength(0);
        const raised = await pendingQuestion(harness, docRef);
        expect(raised.data.prompt).toContain("185.00");
        expect(await harness.questions()).toHaveLength(2);
    });

    it("hashes two differently-ordered encodings of the same call the same", () => {
        const first = { thingId: "i-1", splits: [{ amount: "10.00", date: "2026-01-01" }] };
        const second = { splits: [{ date: "2026-01-01", amount: "10.00" }], thingId: "i-1" };
        expect(canonicalArgsHash(first)).toBe(canonicalArgsHash(second));
        // And number formatting, which the model does not keep stable either.
        expect(canonicalArgsHash({ n: 96.5 })).toBe(canonicalArgsHash({ n: 96.5000 }));
        // But a different call is a different call.
        expect(canonicalArgsHash({ n: 96.5 })).not.toBe(canonicalArgsHash({ n: 96.6 }));
    });

    it("falls back to the raw call rather than describing a posting it cannot read", async () => {
        // A model that emits `splits` as a JSON string is routine. The renderer used to answer
        // "Book a transaction with no postings?" — a safety question describing nothing, which the
        // User would be approving blind. The JSON fallback exists for exactly this.
        const harness = buildHarness([
            {
                turn: 0,
                toolCalls: [
                    { name: "bookkeeping__postTransaction", arguments: { splits: "[{\"amount\":\"10\"}]" } },
                ],
            },
        ]);
        const assistant = await bookingAssistant(harness);
        const docRef = await harness.birth({ assistant });

        await harness.driver.advance(docRef);

        const question = await pendingQuestion(harness, docRef);
        expect(question.data.prompt).toContain("Approval needed");
        expect(question.data.prompt).toContain("```json");
        expect(question.data.prompt).not.toContain("no postings");
        expect(harness.firefly.posted).toHaveLength(0);
    });

    /**
     * The flag arrives from **data**, not from code (ADR-0018, amended). The tests above are the
     * ordinary case — a Thing bootstrap created from a seed that asked for an approval — and these
     * two are the User exercising their sovereignty in each direction.
     */
    it("books without asking when the User has switched the approval off", async () => {
        const harness = buildHarness([
            { turn: 0, toolCalls: [{ name: "bookkeeping__postTransaction", arguments: POSTING }] },
            { turn: 1, text: "Booked.", finishReason: "answered" },
        ]);
        const assistant = await bookingAssistant(harness);
        await editOperation(harness, "bookkeeping.postTransaction", { requiresApproval: false });
        const docRef = await harness.birth({ assistant });

        await harness.driver.advance(docRef);

        // It went through, on the User's decision and with nobody asked. postTransaction is a Dynamic
        // Operation now (ADR-0025): there is no compiled author for the registry to compare the Thing
        // against, so the "weaker than the code shipped with" warning that a built-in raised does not
        // apply here — the trust anchor is the store's write authority, and the edit is authoritative.
        expect(harness.firefly.posted).toHaveLength(1);
        expect(await harness.questions()).toHaveLength(0);
    });

    it("asks about an Operation the User ticked, though its code never required one", async () => {
        const harness = buildHarness([
            { turn: 0, toolCalls: [{ name: "bookkeeping__listAccounts", arguments: {} }] },
        ]);
        const assistant = await harness.seedAssistant({
            grants: [{ operationKey: "bookkeeping.listAccounts" }],
        });
        await editOperation(harness, "bookkeeping.listAccounts", { requiresApproval: true });
        const docRef = await harness.birth({ assistant });

        const result = await harness.driver.advance(docRef);

        expect(result.status).toBe("waiting");
        const question = await pendingQuestion(harness, docRef);
        expect(question.data.prompt).toContain("Approval needed");
        expect(question.data.prompt).toContain("bookkeeping.listAccounts");
    });

    it("leaves an Operation that does not require one alone", async () => {
        const harness = buildHarness([
            { turn: 0, toolCalls: [{ name: "bookkeeping__listAccounts", arguments: {} }] },
            { turn: 1, text: "Here they are.", finishReason: "answered" },
        ]);
        const assistant = await harness.seedAssistant({
            grants: [{ operationKey: "bookkeeping.listAccounts" }],
        });
        const docRef = await harness.birth({ assistant });

        await harness.driver.advance(docRef);

        expect((await harness.conversation(docRef)).data.status).toBe("running");
        expect(await harness.questions()).toHaveLength(0);
    });
});

describe("what a Turn cost (#6)", () => {
    it("records usage on the assistant Entry of a text-reply Turn", async () => {
        const harness = buildHarness([{ text: "All done.", finishReason: "answered" }]);
        const assistant = await harness.seedAssistant();
        const docRef = await harness.birth({ assistant });

        await harness.driver.advance(docRef);

        // The scripted provider reports zeroes — a recording costs nothing — and the zeroes are
        // written, because an absent field and a zero field must not be the same thing.
        const reply = (await harness.conversation(docRef)).data.entries!.find(
            (entry) => entry.kind === "assistant",
        );
        expect(reply?.promptTokens).toBe(0);
        expect(reply?.completionTokens).toBe(0);
    });

    it("records it on the first tool-intent of a tool-calling Turn, and only the first", async () => {
        // A Turn that ends `wants-tools` appends no `assistant` Entry at all, so "the Turn's
        // assistant Entry" names a row that does not exist for most Turns.
        const harness = buildHarness([
            {
                turn: 0,
                toolCalls: [
                    { name: "thingstore__search", arguments: { model: "Party_DM" } },
                    { name: "thingstore__search", arguments: { model: "Invoice_DM" } },
                ],
            },
        ]);
        const assistant = await harness.seedAssistant({ grants: [{ operationKey: "thingstore.search" }] });
        const docRef = await harness.birth({ assistant });

        await harness.driver.advance(docRef);

        const intents = (await harness.conversation(docRef)).data.entries!.filter(
            (entry) => entry.kind === "tool-intent",
        );
        expect(intents).toHaveLength(2);
        expect(intents[0]!.promptTokens).toBe(0);
        expect(intents[0]!.completionTokens).toBe(0);
        expect(intents[1]!.promptTokens).toBeUndefined();
        expect(intents[1]!.completionTokens).toBeUndefined();
    });

    it("records nothing for a Turn that errored", async () => {
        // Usage exists only where a provider returned a response, so the Turns of a Conversation sum
        // to a lower bound on its cost rather than to its cost. Chasing it onto the error paths buys
        // precision nobody will spend.
        const harness = buildHarness([{ finishReason: "error", text: "" }]);
        const assistant = await harness.seedAssistant();
        const docRef = await harness.birth({ assistant });

        await harness.driver.advance(docRef);

        const entries = (await harness.conversation(docRef)).data.entries ?? [];
        expect(entries.some((entry) => entry.promptTokens !== undefined)).toBe(false);
    });

    /**
     * An Operation that bills a model of its own — `document.readScan` and the vision profile —
     * reports what it spent on its result, and the Turn folds it in. Without that, the sum over a
     * Conversation's Turns stops being an honest lower bound in a second way: not only the Turns
     * that errored, but every ordinary successful scan, silently uncounted.
     */
    describe("an Operation that spent on a model of its own", () => {
        /** Register a stand-in that returns whatever the test wants under `usage`. */
        function withSpendingOperation(harness: Harness, value: Record<string, unknown>): void {
            harness.registry.registerAll([
                {
                    name: "test.spends",
                    mutating: false,
                    seed: {
                        name: "Spends tokens",
                        system: "Test",
                        kind: "internal",
                        description: "Returns a result that reports what it spent.",
                        parameters: { type: "object", properties: {} },
                    },
                    execute: async () => ({ kind: "value", value }),
                },
            ]);
            putCatalogue(harness.store, [
                {
                    key: "test.spends",
                    name: "Spends tokens",
                    system: "Test",
                    kind: "internal",
                    description: "Returns a result that reports what it spent.",
                    parameters: '{"type":"object","properties":{}}',
                    mutating: false,
                    enabled: true,
                },
            ]);
        }

        async function tokensAfter(value: Record<string, unknown>): Promise<[number?, number?]> {
            const harness = buildHarness([
                { turn: 0, toolCalls: [{ name: "test__spends", arguments: {} }] },
            ]);
            withSpendingOperation(harness, value);
            const assistant = await harness.seedAssistant({ grants: [{ operationKey: "test.spends" }] });
            const docRef = await harness.birth({ assistant });

            await harness.driver.advance(docRef);

            const intent = (await harness.conversation(docRef)).data.entries!.find(
                (entry) => entry.kind === "tool-intent",
            );
            return [intent?.promptTokens, intent?.completionTokens];
        }

        it("adds what the Operation spent to what the Turn recorded", async () => {
            // The scripted provider reports zeroes, so what is left is exactly the Operation's own.
            expect(await tokensAfter({ text: "an invoice", usage: { promptTokens: 1200, completionTokens: 340 } }))
                .toEqual([1200, 340]);
        });

        it("changes nothing for a result that reports none, or reports it malformed", async () => {
            expect(await tokensAfter({ text: "an invoice" })).toEqual([0, 0]);
            expect(await tokensAfter({ usage: "quite a lot" })).toEqual([0, 0]);
            expect(await tokensAfter({ usage: { promptTokens: "1200" } })).toEqual([0, 0]);
        });

        it("ignores a negative count, which would otherwise subtract from the Turn", async () => {
            // `Number.isFinite(-999999)` is true, so finiteness alone lets this through — and a
            // recorded figure below the truth is the one thing a floor may never be.
            expect(await tokensAfter({ usage: { promptTokens: -999999, completionTokens: -1 } }))
                .toEqual([0, 0]);
        });

        it("takes neither half of a pair when one half is negative", async () => {
            // Deliberate: one report, one Operation. Getting one number wrong is no reason to
            // believe the other, and half a pair would read downstream as a genuine zero.
            expect(await tokensAfter({ usage: { promptTokens: 1200, completionTokens: -5 } }))
                .toEqual([0, 0]);
        });
    });
});

describe("suspension and continuation (ADR-0004, ADR-0005)", () => {
    it("suspends on a question and holds nothing in memory", async () => {
        const harness = buildHarness([
            {
                turn: 0,
                toolCalls: [
                    { name: "ui__askUser", arguments: { kind: "confirm", prompt: "Book **184.30**?" } },
                ],
            },
        ]);
        const assistant = await harness.seedAssistant();
        const docRef = await harness.birth({ assistant });

        const result = await harness.driver.advance(docRef);

        expect(result.status).toBe("waiting");
        const conversation = await harness.conversation(docRef);
        expect(conversation.data.waitingFor).toBe("user");
        expect(conversation.data.leaseUntil).toBe("");
        expect(conversation.data.currentQuestionId).toBeTruthy();

        const questions = await harness.questions();
        expect(questions).toHaveLength(1);
        expect(questions[0]!.data.prompt).toContain("184.30");
        expect(questions[0]!.data.answeredAt).toBeFalsy();
    });

    it("continues when the User answers, through the watcher and nothing else", async () => {
        const harness = buildHarness([
            {
                turn: 0,
                toolCalls: [{ name: "ui__askUser", arguments: { kind: "confirm", prompt: "Go ahead?" } }],
            },
            { turn: 1, text: "Thanks, done.", finishReason: "answered" },
        ]);
        const assistant = await harness.seedAssistant();
        const docRef = await harness.birth({ assistant });
        await harness.driver.advance(docRef);

        const [question] = await harness.questions();
        await harness.answer(question!.thingId, { confirmed: true, text: "yes please" });

        await harness.watcher.scan();

        const conversation = await harness.conversation(docRef);
        expect(conversation.data.status).toBe("done");
        const answer = (conversation.data.entries ?? []).find((entry) => entry.kind === "answer");
        expect(answer?.text).toContain("yes please");
    });

    it("wakes a conversation whose wakeAt has passed", async () => {
        const harness = buildHarness([{ text: "Carrying on.", finishReason: "answered" }]);
        const assistant = await harness.seedAssistant();
        const docRef = await harness.birth({ assistant });

        const conversation = await harness.conversation(docRef);
        await harness.things.update(SPECS.Conversation_DM, docRef, {
            ...conversation.data,
            status: "waiting",
            waitingFor: "assistant",
            wakeAt: nowIso(new Date(Date.now() - 60_000)),
        });

        await harness.watcher.scan();

        const after = await harness.conversation(docRef);
        expect(after.data.status).toBe("done");
        expect((after.data.entries ?? []).some((entry) => entry.kind === "timeout")).toBe(true);
    });
});

/**
 * The crash the intent log exists for: the intent was written, the Operation may or may not have
 * run, and the process died before any result — or any suspension — reached the store. Truncating
 * the transcript at the intent and expiring the lease is exactly that state.
 */
async function crashAfterIntent(harness: Harness, docRef: string): Promise<void> {
    const crashed = await harness.conversation(docRef);
    await harness.things.update(SPECS.Conversation_DM, docRef, {
        ...crashed.data,
        entries: (crashed.data.entries ?? []).filter((entry) => entry.kind !== "tool-result"),
        status: "running",
        waitingFor: "",
        currentQuestionId: "",
        leaseUntil: nowIso(new Date(Date.now() - 60_000)),
    });
}

describe("recovery", () => {
    it("reconciles an interrupted booking instead of re-running it", async () => {
        // Two identical calls, because a booking now costs an approval round trip: the first is
        // refused and asks the User, the second — after the yes — is the one that reaches Firefly.
        const harness = buildHarness([
            { turn: 0, toolCalls: [{ name: "bookkeeping__postTransaction", arguments: POSTING }] },
            { turn: 1, toolCalls: [{ name: "bookkeeping__postTransaction", arguments: POSTING }] },
            { turn: 2, text: "Booked.", finishReason: "answered" },
        ]);
        const assistant = await harness.seedAssistant({
            grants: [{ operationKey: "bookkeeping.postTransaction" }],
        });
        const docRef = await harness.birth({ assistant });

        await harness.driver.advance(docRef);
        expect(harness.firefly.posted).toHaveLength(0);
        await approve(harness, docRef);
        expect(harness.firefly.posted).toHaveLength(1);
        const bookedKey = harness.firefly.posted[0]!.externalId;

        // The crash that matters: Firefly returned 200 and the process died before the result
        // entry reached the store. Dropping the LAST tool-result is exactly that state — and it has
        // to be the last one rather than all of them, because the refused first call has a
        // (pending) result of its own that was written and must stay written.
        const crashed = await harness.conversation(docRef);
        const lastResult = (crashed.data.entries ?? [])
            .filter((entry) => entry.kind === "tool-result")
            .at(-1);
        await harness.things.update(SPECS.Conversation_DM, docRef, {
            ...crashed.data,
            entries: (crashed.data.entries ?? []).filter((entry) => entry !== lastResult),
            status: "running",
            leaseUntil: nowIso(new Date(Date.now() - 60_000)),
        });

        await harness.watcher.scan();

        // Exactly one booking, and the reconciled result carries the ORIGINAL key — the drift
        // that would otherwise mint a fresh key and post again.
        expect(harness.firefly.posted).toHaveLength(1);
        const recovered = await harness.conversation(docRef);
        const result = (recovered.data.entries ?? []).find(
            (entry) => entry.kind === "tool-result" && entry.idempotencyKey === bookedKey,
        );
        expect(result).toBeDefined();
        expect(result!.toolResult).toContain("alreadyExisted");
    });

    it("stops and asks rather than guessing when nothing can say whether the call landed", async () => {
        const harness = buildHarness([
            {
                turn: 0,
                toolCalls: [
                    { name: "thingstore__update", arguments: { model: "Party_DM", thingId: "x", fields: {} } },
                ],
            },
        ]);
        const assistant = await harness.seedAssistant({ grants: [{ operationKey: "thingstore.update" }] });
        const docRef = await harness.birth({ assistant });
        await harness.driver.advance(docRef);

        const crashed = await harness.conversation(docRef);
        await harness.things.update(SPECS.Conversation_DM, docRef, {
            ...crashed.data,
            entries: (crashed.data.entries ?? []).filter((entry) => entry.kind !== "tool-result"),
            status: "running",
            leaseUntil: nowIso(new Date(Date.now() - 60_000)),
        });

        await harness.watcher.scan();

        // thingstore.update reconciles to "may or may not have applied", which is a result, so the
        // conversation carries on informed rather than blind.
        const recovered = await harness.conversation(docRef);
        const results = (recovered.data.entries ?? []).filter((entry) => entry.kind === "tool-result");
        expect(results).toHaveLength(1);
        expect(results[0]!.toolResult).toMatch(/may or may not have applied/i);
    });

    it("returns to waiting on the same question when reconciliation says the suspension still holds", async () => {
        // The crash that matters here: the Open Question was created and the process died before
        // `status="waiting"` reached the store. `ui.askUser.reconcile` answers `pending` — the
        // suspension still holds — and that answer was being read as "settled", so a fresh Turn
        // ran without the answer and the Conversation reached `done` with the User's question
        // still open and `currentQuestionId` cleared, matching no scan ever again.
        const harness = buildHarness([
            {
                turn: 0,
                toolCalls: [{ name: "ui__askUser", arguments: { kind: "confirm", prompt: "Pay 184.30?" } }],
            },
            { turn: 1, text: "No answer came, so I assumed yes.", finishReason: "answered" },
        ]);
        const assistant = await harness.seedAssistant({ grants: [{ operationKey: "ui.askUser" }] });
        const docRef = await harness.birth({ assistant });
        await harness.driver.advance(docRef);
        const questionId = (await harness.conversation(docRef)).data.currentQuestionId!;

        await crashAfterIntent(harness, docRef);
        await harness.watcher.scan();

        const after = await harness.conversation(docRef);
        expect(after.data.status).toBe("waiting");
        expect(after.data.waitingFor).toBe("user");
        expect(after.data.currentQuestionId).toBe(questionId);
        expect(after.data.result).toBeFalsy();

        // And answering it afterwards still finishes, through the ordinary path.
        await harness.answer(questionId, { confirmed: true, text: "yes please" });
        await harness.watcher.scan();
        expect((await harness.conversation(docRef)).data.status).toBe("done");
    });

    it("returns to waiting for a Manual Connector too, on `tool` rather than `user`", async () => {
        // Every Manual Connector returns the identical pending shape, so a crash during a payment
        // request resumed the Assistant as if it had been told nothing, with the request still on
        // the User's list.
        const harness = buildHarness([
            {
                turn: 0,
                toolCalls: [
                    { name: "bank__sendMoney", arguments: { iban: "DE00", amount: "10.00", reference: "r" } },
                ],
            },
            { turn: 1, text: "Recorded.", finishReason: "answered" },
        ]);
        const assistant = await harness.seedAssistant({ grants: [{ operationKey: "bank.sendMoney" }] });
        const docRef = await harness.birth({ assistant });
        await harness.driver.advance(docRef);
        const questionId = (await harness.conversation(docRef)).data.currentQuestionId!;

        await crashAfterIntent(harness, docRef);
        await harness.watcher.scan();

        const after = await harness.conversation(docRef);
        expect(after.data.status).toBe("waiting");
        expect(after.data.waitingFor).toBe("tool");
        expect(after.data.currentQuestionId).toBe(questionId);
    });

    it("records an unknown result for an intent nothing can reconcile, and escalates only once", async () => {
        // The crash one step earlier: the intent was written and the question never created, so
        // `reconcile` can find nothing at all. Escalating is right — but the escalation wrote no
        // result for the intent, so `unresolvedIntent` found it again on every wake and escalated
        // again. Answering was structurally incapable of helping; the fourth escalation killed the
        // Conversation without it ever having taken a Turn.
        //
        // The same omission leaves an assistant tool call with no tool result in the transcript,
        // which OpenAI and Anthropic both reject outright — so the Conversation could not reach a
        // real model either.
        const harness = buildHarness([
            { turn: 0, toolCalls: [{ name: "ui__askUser", arguments: { kind: "confirm", prompt: "Pay?" } }] },
            { turn: 1, text: "Understood, I will not repeat it.", finishReason: "answered" },
        ]);
        const assistant = await harness.seedAssistant({ grants: [{ operationKey: "ui.askUser" }] });
        const docRef = await harness.birth({ assistant });
        await harness.driver.advance(docRef);

        const raised = (await harness.questions())[0]!;
        await harness.things.delete(raised.docRef);
        await crashAfterIntent(harness, docRef);

        await harness.watcher.scan();
        const escalated = await harness.conversation(docRef);
        expect(escalated.data.status).toBe("waiting");
        expect(escalated.data.escalationCount).toBe(1);

        // Every tool call in the transcript has a result — the invariant both real providers need.
        const messages = buildMessages(assistant.data, escalated.data);
        const callIds = messages.flatMap((message) => (message.toolCalls ?? []).map((call) => call.id));
        const resultIds = messages
            .filter((message) => message.role === "tool")
            .map((message) => message.toolCallId);
        expect(callIds.length).toBeGreaterThan(0);
        expect(resultIds).toEqual(callIds);

        // And it says unknown — not failed, and not "try again".
        const result = (escalated.data.entries ?? []).find((entry) => entry.kind === "tool-result")!;
        expect(result.toolResult).toMatch(/"outcome":"unknown"/);
        expect(result.toolResult).toMatch(/"retry":false/);

        // Answering now moves it: one escalation, then a real Turn.
        const open = (await harness.questions()).filter((question) => !question.data.answeredAt);
        for (const question of open) {
            await harness.answer(question.thingId, { text: "It did not happen, carry on." });
        }
        await harness.watcher.scan();

        const resumed = await harness.conversation(docRef);
        expect(resumed.data.escalationCount).toBe(1);
        expect(resumed.data.turnCount).toBe(2);
        expect(resumed.data.status).toBe("done");
    });

    it("reconciles an interrupted assistant.call from the child it already created", async () => {
        // `assistant.call` is the one mutating Operation with no `reconcile`, so an interrupted
        // call could not be answered even though the answer is sitting in the store: the child
        // Conversation was born under the caller's own idempotency key. Without it the recovery
        // path escalates — once per wake — for a call that demonstrably happened.
        const harness = buildHarness([
            {
                assistant: "receptionist",
                turn: 0,
                toolCalls: [{ name: "assistant__call__accountant", arguments: { prompt: "book it" } }],
            },
            { assistant: "accountant", text: "booked", finishReason: "answered" },
            { assistant: "receptionist", turn: 1, text: "Thanks.", finishReason: "answered" },
        ]);
        const receptionist = await harness.seedAssistant({
            key: "receptionist",
            grants: [{ operationKey: "assistant.call:accountant" }],
        });
        await harness.seedAssistant({ key: "accountant", name: "Accountant", triggers: [] });
        const docRef = await harness.birth({ assistant: receptionist });
        await harness.driver.advance(docRef);

        const children = async () =>
            (await harness.things.search<Conversation>(SPECS.Conversation_DM, undefined, 100)).filter(
                (candidate) => candidate.data.assistantKey === "accountant",
            );
        expect(await children()).toHaveLength(1);

        await crashAfterIntent(harness, docRef);
        await harness.watcher.scan();

        // No escalation and no second child: it is waiting for the Assistant it already called.
        const after = await harness.conversation(docRef);
        expect(after.data.status).toBe("waiting");
        expect(after.data.waitingFor).toBe("assistant");
        expect(after.data.escalationCount ?? 0).toBe(0);
        expect(await children()).toHaveLength(1);

        // And the ordinary child-completion delivery still resumes it.
        await harness.driver.advance((await children())[0]!.docRef);
        await harness.watcher.scan();
        expect((await harness.conversation(docRef)).data.status).toBe("done");
    });
});

/**
 * An Operation switched off underneath a Conversation that is already using it.
 *
 * The two states look alike and are reached by different code. A **suspended** call already has a
 * `pending` tool-result written, so `unresolvedIntent` never finds it and the fresh Turn is the
 * only thing that can say anything — through the belt. A **crashed** call has no result at all, so
 * it goes through `reconcile()`, which settles it with *"no longer available"*.
 */
describe("switching an Operation off under a live Conversation", () => {
    const SEND = { iban: "DE00", amount: "10.00", reference: "r" };

    it("tells a resumed Conversation, on its next Turn, that the Operation is switched off", async () => {
        const harness = buildHarness([
            { turn: 0, toolCalls: [{ name: "bank__sendMoney", arguments: SEND }] },
            { turn: 1, toolCalls: [{ name: "bank__sendMoney", arguments: SEND }] },
            { turn: 2, text: "Understood, I will leave it.", finishReason: "answered" },
        ]);
        const assistant = await harness.seedAssistant({ grants: [{ operationKey: "bank.sendMoney" }] });
        const docRef = await harness.birth({ assistant });

        await harness.driver.advance(docRef);
        const suspended = await harness.conversation(docRef);
        expect(suspended.data.status).toBe("waiting");
        expect(suspended.data.waitingFor).toBe("tool");

        // The User switches it off while the Conversation is waiting on it, and then answers.
        await editOperation(harness, "bank.sendMoney", { enabled: false });
        const [question] = await harness.questions();
        const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
        await harness.answer(question!.thingId, { text: "I have sent it by hand." });
        await harness.watcher.scan();
        warnings.mockRestore();

        const results = ((await harness.conversation(docRef)).data.entries ?? []).filter(
            (entry) => entry.kind === "tool-result",
        );
        // The message, not merely the absence of a stranded call: the model has to know why.
        expect(results.at(-1)!.toolResult).toMatch(/"bank\.sendMoney" is switched off/);
        // And this is not the reconciliation path — the suspended call's `pending` result is still
        // there, so nothing was ever unresolved and nothing said "no longer available".
        expect(results.map((entry) => entry.toolResult).join("\n")).not.toMatch(/no longer available/);
        expect(results[0]!.toolResult).toMatch(/"pending":true/);
    });

    it("still settles a call that crashed mid-flight with 'no longer available'", async () => {
        const harness = buildHarness([
            { turn: 0, toolCalls: [{ name: "bank__sendMoney", arguments: SEND }] },
            { turn: 1, text: "Understood, I will leave it.", finishReason: "answered" },
        ]);
        const assistant = await harness.seedAssistant({ grants: [{ operationKey: "bank.sendMoney" }] });
        const docRef = await harness.birth({ assistant });
        await harness.driver.advance(docRef);

        await editOperation(harness, "bank.sendMoney", { enabled: false });
        await crashAfterIntent(harness, docRef);
        const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
        await harness.watcher.scan();
        warnings.mockRestore();

        const after = await harness.conversation(docRef);
        const results = (after.data.entries ?? []).filter((entry) => entry.kind === "tool-result");
        // The existing revoked-grant path, unchanged: nothing is stranded and nothing is repeated.
        expect(results).toHaveLength(1);
        expect(results[0]!.toolResult).toMatch(/"bank\.sendMoney" is no longer available/);
        expect(results[0]!.toolResult).toMatch(/did not take effect/);
        expect(after.data.escalationCount ?? 0).toBe(0);
    });
});

describe("manual connectors", () => {
    it("resumes a conversation suspended on a Manual Connector, not only on askUser", async () => {
        const harness = buildHarness([
            {
                turn: 0,
                toolCalls: [
                    { name: "bank__sendMoney", arguments: { iban: "DE00", amount: "10.00", reference: "r" } },
                ],
            },
            { turn: 1, text: "Thanks, recorded.", finishReason: "answered" },
        ]);
        const assistant = await harness.seedAssistant({ grants: [{ operationKey: "bank.sendMoney" }] });
        const docRef = await harness.birth({ assistant });

        await harness.driver.advance(docRef);
        let conversation = await harness.conversation(docRef);
        // A Manual Connector waits on `tool`, not `user` — the distinction that stranded every
        // one of them.
        expect(conversation.data.status).toBe("waiting");
        expect(conversation.data.waitingFor).toBe("tool");

        const [question] = await harness.questions();
        expect(question!.data.kind).toBe("perform");
        await harness.answer(question!.thingId, { text: "Sent it, reference 12345." });

        await harness.watcher.scan();

        conversation = await harness.conversation(docRef);
        expect(conversation.data.status).toBe("done");
    });
});

describe("guards", () => {
    it("turns exhaustion into an Open Question rather than a silent stop", async () => {
        const harness = buildHarness([
            { toolCalls: [{ name: "thingstore__search", arguments: { model: "Party_DM" } }] },
        ]);
        const assistant = await harness.seedAssistant({ maxTurns: 2 });
        const docRef = await harness.birth({ assistant });

        const conversation = await harness.conversation(docRef);
        await harness.things.update(SPECS.Conversation_DM, docRef, {
            ...conversation.data,
            turnCount: 2,
            maxTurns: 2,
        });

        await harness.driver.advance(docRef);

        const after = await harness.conversation(docRef);
        expect(after.data.status).toBe("waiting");
        expect(after.data.waitingFor).toBe("user");
        expect(after.data.finishReason).toBe("limit");

        const questions = await harness.questions();
        expect(questions).toHaveLength(1);
        expect(questions[0]!.data.kind).toBe("perform");
        expect(questions[0]!.data.prompt).toMatch(/stuck/i);
    });


    it("lets the User's answer buy more turns instead of asking the same question three times", async () => {
        // The max-turns guard returned before changing anything, so answering left `turnCount` at
        // the limit and the next Turn re-entered the same guard. The User was asked three times,
        // the fourth escalation flipped the Conversation to `failed` — and not one Turn was ever
        // taken. The prompt said "Answer to tell it what to do next"; answering demonstrably did
        // nothing.
        const harness = buildHarness([{ turn: 3, text: "Finished.", finishReason: "answered" }]);
        const assistant = await harness.seedAssistant({ maxTurns: 3 });
        const docRef = await harness.birth({ assistant });
        const born = await harness.conversation(docRef);
        await harness.things.update(SPECS.Conversation_DM, docRef, {
            ...born.data,
            turnCount: 3,
            maxTurns: 3,
        });

        await harness.driver.advance(docRef);

        const asked = await harness.conversation(docRef);
        expect(asked.data.status).toBe("waiting");
        expect(asked.data.waitingFor).toBe("user");
        expect(asked.data.finishReason).toBe("limit");
        // The ask is honest: there is now budget for the answer to be acted on.
        expect(asked.data.maxTurns).toBeGreaterThan(3);
        expect(await harness.questions()).toHaveLength(1);

        const [question] = await harness.questions();
        await harness.answer(question!.thingId, { text: "Carry on please." });
        await harness.watcher.scan();

        const after = await harness.conversation(docRef);
        expect(after.data.turnCount).toBe(4); // a real Turn was taken
        expect(after.data.status).toBe("done");
        expect(after.data.escalationCount).toBe(1);
        expect(await harness.questions()).toHaveLength(1); // asked once, not three times
    });

    it("escalates rather than dying when the Assistant it names no longer exists", async () => {
        const harness = buildHarness([]);
        const assistant = await harness.seedAssistant({ key: "receptionist" });
        const docRef = await harness.birth({ assistant });

        // The Assistant is renamed out from under a live Conversation.
        await harness.things.update(SPECS.Assistant_DM, assistant.docRef, {
            ...assistant.data,
            key: "renamed",
        });

        await harness.driver.advance(docRef);

        const conversation = await harness.conversation(docRef);
        // It must NOT end silently in `failed` — it has to reach the User.
        expect(conversation.data.status).toBe("waiting");
        expect(conversation.data.waitingFor).toBe("user");

        const questions = await harness.questions();
        expect(questions).toHaveLength(1);
        expect(questions[0]!.data.prompt).toMatch(/no Assistant with that key exists/i);
    });

    it("refuses to call a disabled Assistant instead of stranding two Conversations", async () => {
        // Nothing checked that the callee was enabled, so the child was born — and then nothing
        // could ever advance either one. Scan 2 filters `waitingFor` in {user, tool} and skips the
        // parent; scan 5 needs the child done or failed; scan 6 skips Conversations whose Assistant
        // is not enabled. Five scans, zero continuations, zero Open Questions, heartbeat green.
        // Exactly what ADR-0015 forbids: "a failed state must never be somewhere a Conversation
        // falls".
        const harness = buildHarness([
            {
                assistant: "receptionist",
                turn: 0,
                toolCalls: [{ name: "assistant__call__accountant", arguments: { prompt: "check this" } }],
            },
        ]);
        const receptionist = await harness.seedAssistant({
            key: "receptionist",
            grants: [{ operationKey: "assistant.call:accountant" }],
        });
        await harness.seedAssistant({ key: "accountant", enabled: false, triggers: [] });
        const docRef = await harness.birth({ assistant: receptionist });

        await harness.driver.advance(docRef);

        const parent = await harness.conversation(docRef);
        // Not suspended on an Assistant that will never run.
        expect(parent.data.status).toBe("running");
        expect(parent.data.waitingFor).toBeFalsy();

        const children = (
            await harness.things.search<Conversation>(SPECS.Conversation_DM, undefined, 100)
        ).filter((candidate) => candidate.data.assistantKey === "accountant");
        expect(children).toHaveLength(0);

        // And the model is told why, as a tool error it can act on.
        const result = (parent.data.entries ?? []).find((entry) => entry.kind === "tool-result");
        expect(result?.toolResult).toMatch(/disabled/i);
    });

    it("stops continuing a disabled Assistant", async () => {
        const harness = buildHarness([{ text: "should not run", finishReason: "answered" }]);
        const assistant = await harness.seedAssistant({ enabled: false });
        const docRef = await harness.birth({ assistant });

        const result = await harness.driver.advance(docRef);

        expect(result.note).toBe("assistant disabled");
        const conversation = await harness.conversation(docRef);
        expect(conversation.data.status).not.toBe("done");
    });
});

describe("answering", () => {
    it("continues when the User fills in the answer but not the timestamp", async () => {
        // The form has no default for `answeredAt` and nothing stamps it. Requiring it meant a
        // User could answer, save successfully, and have the system never notice — silently, on
        // the single most important interaction in the product.
        const harness = buildHarness([
            {
                turn: 0,
                toolCalls: [{ name: "ui__askUser", arguments: { kind: "confirm", prompt: "Book it?" } }],
            },
            { turn: 1, text: "Booked.", finishReason: "answered" },
        ]);
        const assistant = await harness.seedAssistant();
        const docRef = await harness.birth({ assistant });
        await harness.driver.advance(docRef);

        const [question] = await harness.questions();
        // Exactly what the UI produces: text and confirmed set, answeredAt untouched.
        await harness.answer(question!.thingId, {
            confirmed: true,
            text: "Yes, go ahead.",
            answeredAt: "",
        });

        await harness.watcher.scan();

        const conversation = await harness.conversation(docRef);
        expect(conversation.data.status).toBe("done");
    });

    it("recognises a timestamp-less answer when recovering an interrupted question too", async () => {
        // The watcher's scan treats any filled answer field as answered. The two `reconcile` paths
        // still keyed on `answeredAt` alone, so recovery disagreed with the scan about whether the
        // same question had been answered — and a User who typed an answer and pressed Save had, by
        // the watcher's own rule, answered.
        const harness = buildHarness([
            {
                turn: 0,
                toolCalls: [{ name: "ui__askUser", arguments: { kind: "confirm", prompt: "Book it?" } }],
            },
            { turn: 1, text: "Booked.", finishReason: "answered" },
        ]);
        const assistant = await harness.seedAssistant({ grants: [{ operationKey: "ui.askUser" }] });
        const docRef = await harness.birth({ assistant });
        await harness.driver.advance(docRef);

        // The User answers exactly as the UI produces it, and *then* the process dies before the
        // suspension was written.
        const [question] = await harness.questions();
        await harness.answer(question!.thingId, { confirmed: true, text: "Yes, go ahead.", answeredAt: "" });
        await crashAfterIntent(harness, docRef);

        await harness.watcher.scan();

        // Reconciliation saw the answer, so one scan is enough.
        const after = await harness.conversation(docRef);
        expect(after.data.status).toBe("done");
        expect(after.data.escalationCount ?? 0).toBe(0);
    });

    it("treats a bare 'no' as an answer", async () => {
        const harness = buildHarness([
            {
                turn: 0,
                toolCalls: [{ name: "ui__askUser", arguments: { kind: "confirm", prompt: "Book it?" } }],
            },
            { turn: 1, text: "Understood, leaving it.", finishReason: "answered" },
        ]);
        const assistant = await harness.seedAssistant();
        const docRef = await harness.birth({ assistant });
        await harness.driver.advance(docRef);

        const [question] = await harness.questions();
        await harness.answer(question!.thingId, { confirmed: false, answeredAt: "" });
        await harness.watcher.scan();

        expect((await harness.conversation(docRef)).data.status).toBe("done");
    });

    it("does not continue while the question is genuinely unanswered", async () => {
        const harness = buildHarness([
            {
                turn: 0,
                toolCalls: [{ name: "ui__askUser", arguments: { kind: "confirm", prompt: "Book it?" } }],
            },
        ]);
        const assistant = await harness.seedAssistant();
        const docRef = await harness.birth({ assistant });
        await harness.driver.advance(docRef);

        await harness.watcher.scan();

        const conversation = await harness.conversation(docRef);
        expect(conversation.data.status).toBe("waiting");
        expect(conversation.data.waitingFor).toBe("user");
    });
});

describe("recording tool names", () => {
    it("records a per-callee assistant.call under its real name, not the wire name", async () => {
        // `__` maps back to `.` unconditionally, so the transcript used to say
        // `assistant.call.accountant` — a name no tool has. Recovery then concluded the call had
        // not happened, when the child Conversation was already born.
        const harness = buildHarness([
            {
                assistant: "receptionist",
                turn: 0,
                toolCalls: [
                    { name: "assistant__call__accountant", arguments: { prompt: "check this" } },
                ],
            },
        ]);
        const receptionist = await harness.seedAssistant({
            key: "receptionist",
            grants: [{ operationKey: "assistant.call:accountant" }],
        });
        await harness.seedAssistant({ key: "accountant", grants: [{ operationKey: "thingstore.get" }] });

        const docRef = await harness.birth({ assistant: receptionist });
        await harness.driver.advance(docRef);

        const conversation = await harness.conversation(docRef);
        const intent = (conversation.data.entries ?? []).find((entry) => entry.kind === "tool-intent");
        expect(intent?.toolName).toBe("assistant.call:accountant");
    });

    it("records the real name of a per-callee assistant.call that was dropped, too", async () => {
        // The un-mangling only applied where the Operation resolved, and the likeliest reason it
        // does not is the one this system exists to make visible: the User switched `assistant.call`
        // off. The transcript then said `assistant.call.accountant` — a name no grant carries — so
        // the record of a refused call named an Operation nobody could look up.
        const harness = buildHarness([
            {
                assistant: "receptionist",
                turn: 0,
                toolCalls: [
                    { name: "assistant__call__accountant", arguments: { prompt: "check this" } },
                ],
            },
        ]);
        await editOperation(harness, "assistant.call", { enabled: false });
        const receptionist = await harness.seedAssistant({
            key: "receptionist",
            grants: [{ operationKey: "assistant.call:accountant" }],
        });
        const docRef = await harness.birth({ assistant: receptionist });
        const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

        await harness.driver.advance(docRef);
        warnings.mockRestore();

        const entries = (await harness.conversation(docRef)).data.entries ?? [];
        expect(entries.find((entry) => entry.kind === "tool-intent")?.toolName).toBe(
            "assistant.call:accountant",
        );
        expect(entries.find((entry) => entry.kind === "tool-result")?.toolName).toBe(
            "assistant.call:accountant",
        );
    });
});

describe("assistant-to-assistant calls (ADR-0007)", () => {
    it("suspends the caller and delivers the callee's result exactly once", async () => {
        const harness = buildHarness([
            {
                assistant: "receptionist",
                turn: 0,
                toolCalls: [
                    { name: "assistant__call__accountant", arguments: { prompt: "Please check this invoice." } },
                ],
            },
            { assistant: "accountant", text: "Checked: it looks fine.", finishReason: "answered" },
            { assistant: "receptionist", turn: 1, text: "Thanks.", finishReason: "answered" },
        ]);

        const receptionist = await harness.seedAssistant({
            key: "receptionist",
            grants: [{ operationKey: "assistant.call:accountant" }],
        });
        await harness.seedAssistant({
            key: "accountant",
            grants: [{ operationKey: "thingstore.get" }],
            triggers: [{ kind: "assistant-call" }],
        });

        const parentRef = await harness.birth({ assistant: receptionist });
        await harness.driver.advance(parentRef);

        let parent = await harness.conversation(parentRef);
        expect(parent.data.status).toBe("waiting");
        expect(parent.data.waitingFor).toBe("assistant");

        const children = (
            await harness.things.search<Conversation>(SPECS.Conversation_DM, undefined, 10)
        ).filter((candidate) => candidate.data.parentConversationId === parent.thingId);
        expect(children).toHaveLength(1);

        await harness.driver.advance(children[0]!.docRef);
        await harness.watcher.scan();

        parent = await harness.conversation(parentRef);
        expect(parent.data.status).toBe("done");

        const child = await harness.conversation(children[0]!.docRef);
        expect(child.data.resultDeliveredAt).toBeTruthy();

        // A second scan must not deliver the result again.
        const before = (parent.data.entries ?? []).length;
        await harness.watcher.scan();
        const again = await harness.conversation(parentRef);
        expect((again.data.entries ?? []).length).toBe(before);
    });
});
