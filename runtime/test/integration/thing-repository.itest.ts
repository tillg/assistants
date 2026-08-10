/**
 * `ThingRepository` against the live store: idempotent creation, and the model map itself.
 *
 * The model map is the part that cannot be tested without a server. `toDocument`/`fromDocument`
 * are each other's inverse whatever the field names are, so an in-memory round trip passes even
 * when a group field is named `Operation` and the model calls it `ToolOperation` — the value
 * simply lands somewhere the store would have rejected or dropped. Writing it and reading it
 * back is the only assertion that catches that class of bug.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { A12RpcError } from "../../src/a12/client.js";
import type { A12Client } from "../../src/a12/client.js";
import { SPECS, ThingRepository, eq, path } from "../../src/a12/things.js";
import type { ModelSpec } from "../../src/a12/things.js";
import type { ThingModel } from "../../src/domain/types.js";
import {
    LONG_AGO,
    newClient,
    newJanitor,
    newThings,
    THING_STORE_UP,
    Trash,
    unique,
} from "./support/live.js";

/** One representative payload per Model, exercising every scalar field and every group. */
const PAYLOADS: Record<ThingModel, Record<string, unknown>> = {
    Party_DM: {
        kind: "person",
        role: "doctor",
        name: "itest Party",
        legalName: "itest Party GmbH",
        email: "party@example.invalid",
        phone: "+49 2234 000000",
        street: "Hauptstr. 1",
        postcode: "50226",
        city: "Frechen",
        country: "DE",
        iban: "DE02120300000000202051",
        notes: "line one\nline two",
    },
    Document_DM: {
        title: "itest Document",
        receivedAt: "2026-08-01T09:00:00",
        source: "email",
        mediaType: "application/pdf",
        externalRef: "itest-ref-1",
        extractedText: "Rechnung\n\nBetrag: 184,30 EUR",
        classification: "invoice",
        classifiedThingId: "00000000-0000-0000-0000-000000000001",
        classifiedModel: "Invoice_DM",
        classificationNote: "classified by the itest suite",
    },
    Invoice_DM: {
        invoiceNumber: "itest-2026-0001",
        issuedByPartyThingId: "00000000-0000-0000-0000-000000000002",
        issuerName: "itest Dr Meyer",
        issueDate: "2026-08-01",
        dueDate: "2026-08-31",
        serviceDate: "2026-07-28",
        amountGross: 184.3,
        amountNet: 154.87,
        currency: "EUR",
        subject: "Consultation",
        recipientName: "itest Household",
        documentThingId: "00000000-0000-0000-0000-000000000003",
        processThingId: "00000000-0000-0000-0000-000000000004",
        notes: "gross\nnet",
    },
    Process_DM: {
        title: "itest Process",
        kind: "reimbursement",
        status: "open",
        summary: "## Summary\n\nA multi-line summary.",
        steps: [
            { seq: 1, title: "Collect", state: "done", note: "first\nstep", doneAt: "2026-08-01T10:00:00" },
            { seq: 2, title: "Submit", state: "open", note: "second" },
        ],
        related: [{ thingId: "00000000-0000-0000-0000-000000000005", model: "Invoice_DM", note: "the bill" }],
    },
    Assistant_DM: {
        key: "itest-assistant",
        name: "itest Assistant",
        description: "Created by the integration tier; never enabled.",
        systemPrompt: "# You\n\nYou are a fixture.",
        llmModel: "scripted",
        // Never enabled: the live Watcher skips `enabled === false`, so this fixture cannot be
        // triggered while it exists.
        enabled: false,
        maxTurns: 7,
        skills: [{ name: "itest-skill", instructions: "Do\nnothing." }],
        triggers: [{ kind: "assistant-call", modelFilter: "", cron: "" }],
        // The field the model calls `ToolOperation`. An in-memory round trip cannot tell the
        // difference between this and a wrong name; the store can.
        tools: [{ operation: "thingstore.get" }, { operation: "bookkeeping.getBalance" }],
    },
    Conversation_DM: {
        assistantKey: "itest-assistant",
        title: "itest Conversation",
        subjectThingId: "00000000-0000-0000-0000-000000000006",
        subjectModel: "Invoice_DM",
        // `done`, unparented, no wakeAt/leaseUntil/currentQuestionId: inert for all six scans,
        // which matters because we are forbidden from deleting it again.
        status: "done",
        waitingFor: "",
        finishReason: "answered",
        turnCount: 2,
        maxTurns: 20,
        escalationCount: 0,
        result: "Nothing to do.",
        entries: [
            { seq: 1, at: "2026-08-01T10:00:00", role: "user", kind: "prompt", text: "Do the thing." },
            {
                seq: 2,
                at: "2026-08-01T10:00:01",
                role: "assistant",
                kind: "tool-intent",
                text: "",
                toolName: "thingstore__get",
                toolArgs: '{"thingId":"x"}',
                toolResult: "",
                idempotencyKey: "itest:entry:2",
            },
        ],
    },
    OpenQuestion_DM: {
        conversationId: "00000000-0000-0000-0000-000000000007",
        assistantKey: "itest-assistant",
        seq: 1,
        kind: "choice",
        subjectThingId: "00000000-0000-0000-0000-000000000008",
        prompt: "## Which one?\n\nPick a side.",
        options: [
            { value: "a", label: "Option A" },
            { value: "b", label: "Option B" },
        ],
        text: "answered by the itest suite",
        choice: "a",
        confirmed: true,
        // Answered from the start, so it is never an open question in the UI.
        answeredAt: "2026-08-01T10:05:00",
    },
    RuntimeState_DM: {
        // Deliberately NOT `the-one`: the live Runtime looks its state up by singleton key.
        singletonKey: "itest",
        watermark: "2026-08-01T10:00:00",
        watermarkDocRefs: [{ docRef: "Invoice_DM/00000000-0000-0000-0000-000000000009" }],
        paused: false,
        birthsThisHour: 3,
        birthWindowStartedAt: "2026-08-01T09:00:00",
        heartbeatAt: "2026-08-01T10:00:00",
        lastError: "none\nat all",
    },
};

/** The two Models the Runtime owns; we reuse one fixture each instead of deleting. */
const KEEP: ThingModel[] = ["Conversation_DM", "OpenQuestion_DM"];

/**
 * The Models only the **User** may write (D-007a). The round trip is about the model map, not
 * about authorization, so it uses the identity that is allowed to do it — and the refusal the
 * Runtime gets is asserted separately, below, rather than being silently designed around.
 */
const USER_OWNED: ThingModel[] = ["Assistant_DM"];

describe.skipIf(!THING_STORE_UP)("ThingRepository against the live ThingStore", () => {
    let client: A12Client;
    let things: ThingRepository;
    let asUser: ThingRepository;
    const trash = new Trash();

    beforeAll(async () => {
        client = newClient();
        await client.login();
        things = newThings(client);
        const janitor = newJanitor();
        await janitor.login();
        asUser = newThings(janitor);
    });

    afterAll(async () => {
        expect(await trash.empty()).toEqual([]);
    });

    describe("search-then-create", () => {
        it("returns the same Thing for a repeated idempotency key, and creates only one", async () => {
            const key = unique("create-idempotent");

            const first = await things.create(SPECS.Party_DM, {
                name: "itest Idempotent Party",
                kind: "person",
                createdAt: LONG_AGO,
                idempotencyKey: key,
            });
            trash.add(first.docRef);

            const second = await things.create(SPECS.Party_DM, {
                name: "itest Idempotent Party (second attempt)",
                kind: "person",
                createdAt: LONG_AGO,
                idempotencyKey: key,
            });
            trash.add(second.docRef);

            expect(second.docRef).toBe(first.docRef);
            expect(second.thingId).toBe(first.thingId);

            const all = await things.search(SPECS.Party_DM, eq(path(SPECS.Party_DM, "idempotencyKey"), key), 10);
            expect(all).toHaveLength(1);
            // The second call was a read, not a write: the first values still stand.
            expect((all[0]!.data as { name?: string }).name).toBe("itest Idempotent Party");

            const found = await things.findByIdempotencyKey(SPECS.Party_DM, key);
            expect(found?.docRef).toBe(first.docRef);
        });

        it("creates two distinct Things for two distinct keys", async () => {
            const a = await things.create(SPECS.Party_DM, {
                name: "itest Distinct A",
                createdAt: LONG_AGO,
                idempotencyKey: unique("distinct-a"),
            });
            const b = await things.create(SPECS.Party_DM, {
                name: "itest Distinct B",
                createdAt: LONG_AGO,
                idempotencyKey: unique("distinct-b"),
            });
            trash.add(a.docRef);
            trash.add(b.docRef);
            expect(a.thingId).not.toBe(b.thingId);
        });
    });

    describe("the model map", () => {
        for (const model of Object.keys(PAYLOADS) as ThingModel[]) {
            it(`round-trips a ${model} through the store`, async () => {
                const spec = (SPECS as Record<string, ModelSpec>)[model]!;
                const payload = PAYLOADS[model];
                // The two Runtime-owned Models keep a stable key so a re-run reuses one fixture
                // rather than accumulating documents we are not allowed to delete.
                const key = KEEP.includes(model)
                    ? `itest:model-map:${model}`
                    : unique(`model-map:${model}`);

                // An Assistant is the User's to write; everything else is written as the
                // Runtime, because that is who writes it in production.
                const writer = USER_OWNED.includes(model) ? asUser : things;

                const created = await writer.create(spec, {
                    ...payload,
                    createdAt: LONG_AGO,
                    idempotencyKey: key,
                });
                trash.add(created.docRef);
                expect(created.docRef.startsWith(`${model}/`)).toBe(true);

                const loaded = await things.get<Record<string, unknown>>(spec, created.docRef);
                expect(loaded.model).toBe(model);
                expect(loaded.thingId).toBe(created.thingId);
                expect(loaded.data["idempotencyKey"]).toBe(key);
                expect(loaded.data["createdAt"]).toBe(LONG_AGO);

                for (const [property, expected] of Object.entries(payload)) {
                    expect(
                        loaded.data[property],
                        `${model}.${property} did not survive the round trip`,
                    ).toEqual(expected);
                }

                // And the same values come back through a QUERY projection, not just GET.
                const [viaQuery] = await things.search<Record<string, unknown>>(
                    spec,
                    eq(path(spec, "idempotencyKey"), key),
                    2,
                );
                expect(viaQuery?.docRef).toBe(created.docRef);
            });
        }

        it("updates a Thing in place and stamps updatedAt", async () => {
            const key = unique("model-map:update");
            const created = await things.create(SPECS.Process_DM, {
                ...PAYLOADS.Process_DM,
                createdAt: LONG_AGO,
                idempotencyKey: key,
            });
            trash.add(created.docRef);

            await things.update(SPECS.Process_DM, created.docRef, {
                ...PAYLOADS.Process_DM,
                createdAt: LONG_AGO,
                idempotencyKey: key,
                status: "closed",
                steps: [{ seq: 1, title: "Collect", state: "done", note: "only step left" }],
            });

            const loaded = await things.get<Record<string, unknown>>(SPECS.Process_DM, created.docRef);
            expect(loaded.data["status"]).toBe("closed");
            expect(loaded.data["steps"]).toEqual([
                { seq: 1, title: "Collect", state: "done", note: "only step left" },
            ]);
            expect(String(loaded.data["updatedAt"] ?? "")).not.toBe(LONG_AGO);
        });
    });

    // BUG-23. README's Things table says an Assistant is written by "User only — the Runtime reads
    // it", and until D-007a nothing but a string array inside the Runtime's own process enforced
    // it: the `runtime` identity could create an Assistant and rewrite an existing one's
    // SystemPrompt, Enabled, MaxTurns and Tools — which is the whole of what an Assistant may do.
    // The store refuses both now. These are the tests that catch it coming back.
    describe("an Assistant is the User's to write, and the store enforces it", () => {
        it("refuses to let the Runtime identity CREATE an Assistant", async () => {
            const denied = await things
                .create(SPECS.Assistant_DM, {
                    ...PAYLOADS.Assistant_DM,
                    key: unique("runtime-may-not-create"),
                    createdAt: LONG_AGO,
                    idempotencyKey: unique("assistant:create-denied"),
                })
                .then(
                    (created) => {
                        // Only reached when the guard is gone. Register it so a red run does not
                        // leave a rogue Assistant behind in the store.
                        trash.add(created.docRef);
                        return created;
                    },
                    (error: unknown) => error as A12RpcError,
                );

            expect(denied).toBeInstanceOf(A12RpcError);
            const error = denied as A12RpcError;
            expect(error.rpcError.code).toBe(-32059);
            expect(error.reason).toMatch(/Access Denied/i);
        });

        it("refuses to let the Runtime identity MODIFY an Assistant the User created", async () => {
            const key = unique("assistant:modify-denied");
            const existing = await asUser.create(SPECS.Assistant_DM, {
                ...PAYLOADS.Assistant_DM,
                key: unique("runtime-may-not-modify"),
                createdAt: LONG_AGO,
                idempotencyKey: key,
            });
            trash.add(existing.docRef);

            const denied = await things
                .update(SPECS.Assistant_DM, existing.docRef, {
                    ...PAYLOADS.Assistant_DM,
                    // The escalation the guard exists to stop: an Assistant granting itself the
                    // Operation that moves money.
                    tools: [{ operation: "bookkeeping.postTransaction" }],
                    enabled: true,
                    idempotencyKey: key,
                })
                .then(
                    () => undefined,
                    (error: unknown) => error as A12RpcError,
                );

            expect(denied).toBeInstanceOf(A12RpcError);
            expect((denied as A12RpcError).rpcError.code).toBe(-32059);

            // The refusal is a refusal, not a partial write.
            const loaded = await things.get<Record<string, unknown>>(
                SPECS.Assistant_DM,
                existing.docRef,
            );
            expect(loaded.data["tools"]).toEqual(PAYLOADS.Assistant_DM["tools"]);
            expect(loaded.data["enabled"]).toBe(false);
        });

        it("still lets the Runtime identity write the Models it does own", async () => {
            // The other half of the guard: deny too much and the whole system stops. A
            // Conversation and an OpenQuestion are the Runtime's, and it must keep both.
            for (const model of KEEP) {
                const spec = (SPECS as Record<string, ModelSpec>)[model]!;
                const stored = await things.create(spec, {
                    ...PAYLOADS[model],
                    createdAt: LONG_AGO,
                    idempotencyKey: `itest:still-writable:${model}`,
                });
                await things.update(spec, stored.docRef, {
                    ...PAYLOADS[model],
                    createdAt: LONG_AGO,
                    idempotencyKey: `itest:still-writable:${model}`,
                });
            }
        });
    });
});
