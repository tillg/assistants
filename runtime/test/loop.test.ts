/**
 * The loop driver's branching.
 *
 * These are the behaviours the ADRs assert and nothing else verifies: that an Assistant which
 * asks a question holds nothing in memory, that continuation is re-entry rather than a second
 * mechanism, and that recovering a crashed Turn does not do the work twice.
 */

import { describe, expect, it } from "vitest";
import { buildHarness, nowIso } from "./support/harness.js";
import { SPECS } from "../src/a12/things.js";
import type { Conversation } from "../src/domain/types.js";

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

describe("tool gating (ADR-0010)", () => {
    it("does not offer an Assistant a tool it has not declared", async () => {
        const harness = buildHarness([]);
        const assistant = await harness.seedAssistant({
            tools: [{ operation: "thingstore.get" }],
        });
        const schemas = harness.registry.schemasFor(assistant.data);
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
        const assistant = await harness.seedAssistant({ tools: [{ operation: "thingstore.get" }] });
        const docRef = await harness.birth({ assistant });
        await harness.driver.advance(docRef);

        const conversation = await harness.conversation(docRef);
        const result = (conversation.data.entries ?? []).find((entry) => entry.kind === "tool-result");
        expect(result?.toolResult).toMatch(/not one of your tools/);
        expect(harness.firefly.posted).toHaveLength(0);
    });

    it("rejects an Assistant calling itself", async () => {
        const harness = buildHarness([]);
        const assistant = await harness.seedAssistant({
            key: "receptionist",
            tools: [{ operation: "assistant.call:receptionist" }, { operation: "assistant.call:accountant" }],
        });
        const callees = harness.registry.calleesOf(assistant.data);
        expect(callees).toEqual(["accountant"]);
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

describe("recovery", () => {
    it("reconciles an interrupted booking instead of re-running it", async () => {
        const harness = buildHarness([
            {
                turn: 0,
                toolCalls: [
                    {
                        name: "bookkeeping__postTransaction",
                        arguments: {
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
                        },
                    },
                ],
            },
            { turn: 1, text: "Booked.", finishReason: "answered" },
        ]);
        const assistant = await harness.seedAssistant({
            tools: [{ operation: "bookkeeping.postTransaction" }],
        });
        const docRef = await harness.birth({ assistant });

        await harness.driver.advance(docRef);
        expect(harness.firefly.posted).toHaveLength(1);
        const bookedKey = harness.firefly.posted[0]!.externalId;

        // The crash that matters: Firefly returned 200 and the process died before the result
        // entry reached the store. Truncating the transcript at the intent is exactly that state.
        const crashed = await harness.conversation(docRef);
        await harness.things.update(SPECS.Conversation_DM, docRef, {
            ...crashed.data,
            entries: (crashed.data.entries ?? []).filter((entry) => entry.kind !== "tool-result"),
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
        const assistant = await harness.seedAssistant({ tools: [{ operation: "thingstore.update" }] });
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
        const assistant = await harness.seedAssistant({ tools: [{ operation: "bank.sendMoney" }] });
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
            tools: [{ operation: "assistant.call:accountant" }],
        });
        await harness.seedAssistant({
            key: "accountant",
            tools: [{ operation: "thingstore.get" }],
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
