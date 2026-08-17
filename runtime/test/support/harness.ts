/** Wires a whole Runtime around the in-memory store, so tests can drive real scans and Turns. */

import { MemoryStore } from "./memory-store.js";
import { ThingRepository, SPECS, nowIso, toDocument } from "../../src/a12/things.js";
import type { A12Client } from "../../src/a12/client.js";
import { LoopDriver } from "../../src/loop/advance.js";
import { OperationRegistry, type GrantedOperation } from "../../src/operations/registry.js";
import { buildOperations } from "../../src/operations/implementations.js";
import { Watcher, RUNTIME_STATE_KEY } from "../../src/watcher/watcher.js";
import { ScriptedProvider, type ScriptedStep } from "../../src/llm/scripted.js";
import type { FireflyConnector } from "../../src/connectors/firefly.js";
import type { Assistant, Conversation, OpenQuestion, Operation, Stored } from "../../src/domain/types.js";
import { ASSISTANT_SEEDS } from "../../src/bootstrap/assistants.js";

/**
 * The catalogue a bootstrapped stack has: one Operation per registered Implementation, from its
 * seed, all enabled.
 *
 * It lives here rather than on the registry deliberately. `advance()` reads the catalogue from the
 * store and refuses an empty one, and architecture.md is explicit that there is **no fallback to
 * the seeds** — so a seed-derived catalogue reachable from `src/` would keep alive exactly the
 * behaviour that decision forbids. In `test/` it is a fixture, which is all it ever was.
 */
export function seedCatalogue(registry: OperationRegistry): Operation[] {
    return registry.all().map((implementation) => ({
        key: implementation.name,
        name: implementation.seed.name,
        system: implementation.seed.system,
        kind: implementation.seed.kind,
        description: implementation.seed.description,
        parameters: JSON.stringify(implementation.seed.parameters),
        mutating: implementation.mutating,
        requiresApproval: implementation.seed.requiresApproval ?? false,
        enabled: true,
    }));
}

/** Put a catalogue in the store, as bootstrap would have. Synchronous, so `buildHarness` can be. */
export function putCatalogue(store: MemoryStore, catalogue: Operation[]): void {
    for (const operation of catalogue) {
        store.seed(SPECS.Operation_DM.model, toDocument(SPECS.Operation_DM, { ...operation }));
    }
}

/** Take the catalogue away, which is what a stack that never ran `just bootstrap` looks like. */
export function clearCatalogue(store: MemoryStore): void {
    for (const [docRef, row] of store.rows) {
        if (row.documentModelName === SPECS.Operation_DM.model) store.rows.delete(docRef);
    }
}

export interface Harness {
    store: MemoryStore;
    things: ThingRepository;
    registry: OperationRegistry;
    /**
     * The catalogue in the store, and the one the resolution tests resolve against. A test that
     * cares about a switched-off or hand-edited Operation edits the stored Thing, or builds its own.
     */
    catalogue: Operation[];
    driver: LoopDriver;
    watcher: Watcher;
    firefly: FakeFirefly;
    seedAssistant(overrides?: Partial<Assistant>): Promise<Stored<Assistant>>;
    birth(input: {
        assistant: Stored<Assistant>;
        prompt?: string;
        subjectThingId?: string;
        subjectModel?: string;
        scheduledFor?: string;
    }): Promise<string>;
    conversation(docRef: string): Promise<Stored<Conversation>>;
    questions(): Promise<Stored<OpenQuestion>[]>;
    answer(questionId: string, answer: Partial<OpenQuestion>): Promise<void>;
}

/** A working Firefly stand-in that records what it was asked to do. */
export class FakeFirefly {
    readonly posted: Array<{ externalId: string; amount: string }> = [];
    // `liabilities`, PLURAL, because that is what Firefly's read API answers — its write API takes
    // the singular. The fake used to say `liability`, which is exactly the mistake that made
    // `listOpenItems` report nothing while thousands were owed: a fake agreeing with the bug.
    // `currentBalance` and `currencyCode` are the connector's own field names, and they are here
    // because a fake that answers a narrower shape than the real thing lets a projection drop a field
    // without any test noticing — which is how `currency` went missing from `listAccounts` for as long
    // as it did.
    accounts = [
        { id: "1", name: "Checking", type: "asset", currentBalance: "8400.00", currencyCode: "EUR" },
        { id: "2", name: "Payables", type: "liabilities", currentBalance: "-340.00", currencyCode: "EUR" },
        { id: "3", name: "Expenses:Health", type: "expense", currentBalance: "0.00", currencyCode: "EUR" },
    ];

    async listAccounts() {
        return this.accounts;
    }

    /**
     * Firefly's *group* shape, because that is what `projectTransactionGroup` consumes.
     *
     * Deliberately unlike the demo household, which cannot exercise what matters here: measured
     * against the live stack, 21 of its 24 transactions share one date and **no group has more than
     * one split**. So the second group below carries two, and the dates descend — the flattening and
     * the ordering are only really asserted against fixtures built to have them.
     *
     * Amounts carry twelve decimal places because that is what Firefly returns (`"96.500000000000"`),
     * and a fake that tidies them up would hide every formatting bug in the tile that renders them.
     */
    transactions: Array<Record<string, unknown>> = [
        {
            id: "163",
            attributes: {
                transactions: [
                    {
                        type: "withdrawal",
                        date: "2026-08-01T00:00:00+02:00",
                        amount: "96.500000000000",
                        description: "Consultation and dressing change, 24 July",
                        currency_code: "EUR",
                        source_name: "Payables",
                        destination_name: "Expenses:Health",
                    },
                ],
            },
        },
        {
            id: "142",
            attributes: {
                transactions: [
                    {
                        type: "withdrawal",
                        date: "2026-07-02T00:00:00+02:00",
                        amount: "84.200000000000",
                        description: "Stadtwerke Frechen",
                        currency_code: "EUR",
                        source_name: "Checking",
                        destination_name: "Expenses:Utilities",
                    },
                    {
                        type: "deposit",
                        date: "2026-07-02T00:00:00+02:00",
                        amount: "12.000000000000",
                        description: "Stadtwerke refund",
                        currency_code: "EUR",
                        source_name: "Expenses:Utilities",
                        destination_name: "Checking",
                    },
                ],
            },
        },
    ];

    async listTransactions(input: { start: string; end: string; accountName?: string; limit?: number }) {
        void input;
        return this.transactions;
    }
    async resolveAccountId(name: string) {
        const found = this.accounts.find((account) => account.name === name);
        if (!found) throw new Error(`No account named "${name}"`);
        return found.id;
    }
    /** Make the next post fail the way the real Firefly does — with its `details.errors` intact. */
    failNextPost: Error | undefined;

    async postTransaction(input: { externalId: string; splits: Array<{ amount: string; sourceAccount: string; destinationAccount: string }> }) {
        if (this.failNextPost) {
            const failure = this.failNextPost;
            this.failNextPost = undefined;
            throw failure;
        }
        const already = this.posted.find((entry) => entry.externalId === input.externalId);
        if (already) return { id: "existing", alreadyExisted: true };
        for (const split of input.splits) {
            await this.resolveAccountId(split.sourceAccount);
            await this.resolveAccountId(split.destinationAccount);
        }
        this.posted.push({ externalId: input.externalId, amount: input.splits[0]?.amount ?? "0" });
        return { id: `txn-${this.posted.length}`, alreadyExisted: false };
    }
    async findByExternalId(externalId: string) {
        return this.posted.some((entry) => entry.externalId === externalId) ? { id: "existing" } : undefined;
    }
    async getBalance(account: string) {
        return { account, balance: "0.00", currency: "EUR" };
    }
    async listOpenItems() {
        return [];
    }
    async listBudgets(period: { start: string; end: string }) {
        // A period is required, and `spent` is a number that is never null: Firefly answers `[]` for
        // an unspent budget, and the connector normalises that to 0 so "nothing spent" cannot be
        // mistaken for "unknown".
        void period;
        return [{ id: "1", name: "Health", spent: 0, limit: 300, currency: "EUR" }];
    }
    async createBudget() {
        return { id: "b1" };
    }
    async setBudgetLimit() {}
    async createAccount(input: { name: string; type: string }) {
        const created = {
            id: String(this.accounts.length + 1),
            name: input.name,
            type: input.type,
            // Firefly answers a freshly created account with a zero balance in the stack's currency;
            // omitting them here would make a created account the one shape the fake cannot produce.
            currentBalance: "0.00",
            currencyCode: "EUR",
        };
        this.accounts.push(created);
        return created;
    }
    async isReachable() {
        return true;
    }
}

export function buildHarness(
    steps: ScriptedStep[],
    options: {
        maxBirthsPerHour?: number;
        scheduleTimezone?: string;
        /**
         * Reuse an existing store, which is how a **restart** is simulated: a second Runtime over
         * the same data, holding none of the first one's in-memory state. That is the interesting
         * case for anything claiming to be exactly-once.
         */
        store?: MemoryStore;
    } = {},
): Harness {
    const store = options.store ?? new MemoryStore();
    const things = new ThingRepository(store as unknown as A12Client);
    const firefly = new FakeFirefly();
    const registry = new OperationRegistry();

    let llmContext = { assistantKey: "", turn: 0 };
    const llm = new ScriptedProvider(steps, () => llmContext);

    async function createQuestion(input: {
        conversation: Stored<Conversation>;
        assistantKey: string;
        kind: "free-text" | "confirm" | "choice" | "perform";
        prompt: string;
        options?: Array<{ value: string; label: string }>;
        subjectThingId?: string;
        idempotencyKey: string;
    }): Promise<string> {
        const created = await things.create<Record<string, unknown>>(SPECS.OpenQuestion_DM, {
            conversationId: input.conversation.thingId,
            assistantKey: input.assistantKey,
            kind: input.kind,
            prompt: input.prompt,
            options: input.options ?? [],
            subjectThingId: input.subjectThingId ?? "",
            idempotencyKey: input.idempotencyKey,
        });
        return created.thingId;
    }

    async function birthConversation(input: {
        assistant: Stored<Assistant>;
        subjectThingId?: string;
        subjectModel?: string;
        scheduledFor?: string;
        prompt: string;
        title: string;
        parentConversationId?: string;
        idempotencyKey: string;
    }): Promise<string> {
        const created = await things.create<Record<string, unknown>>(SPECS.Conversation_DM, {
            assistantKey: input.assistant.data.key ?? "",
            title: input.title,
            subjectThingId: input.subjectThingId ?? "",
            subjectModel: input.subjectModel ?? "",
            scheduledFor: input.scheduledFor ?? "",
            status: "running",
            waitingFor: "",
            turnCount: 0,
            maxTurns: input.assistant.data.maxTurns ?? 20,
            escalationCount: 0,
            parentConversationId: input.parentConversationId ?? "",
            entries: [{ seq: 1, at: nowIso(), role: "user", kind: "prompt", text: input.prompt }],
            idempotencyKey: input.idempotencyKey,
        });
        return created.docRef;
    }

    const driver = new LoopDriver({
        things,
        registry,
        llm,
        setLlmContext(context) {
            llmContext = context;
        },
        leaseSeconds: 120,
        maxEscalations: 3,
        llmMaxAttempts: 2,
        defaultModel: "test",
        raiseQuestion: (input) => createQuestion(input),
    });

    registry.registerAll(
        buildOperations({
            things,
            firefly: firefly as unknown as FireflyConnector,
            raiseQuestion: (input) =>
                createQuestion({
                    conversation: input.context.conversation,
                    assistantKey: input.context.assistant.data.key ?? "",
                    kind: input.kind,
                    prompt: input.prompt,
                    options: input.options,
                    subjectThingId: input.subjectThingId,
                    idempotencyKey: input.context.idempotencyKey,
                }),
            async callAssistant(input) {
                const found = await things.search<Assistant>(
                    SPECS.Assistant_DM,
                    { operator: "exact_match", field: "/Assistant/Key", value: input.assistantKey },
                    2,
                );
                const callee = found[0];
                if (!callee) throw new Error(`No Assistant with key "${input.assistantKey}"`);
                const docRef = await birthConversation({
                    assistant: callee,
                    subjectThingId: input.subjectThingId,
                    subjectModel: input.subjectModel,
                    title: `called ${input.assistantKey}`,
                    prompt: input.prompt,
                    parentConversationId: input.context.conversation.thingId,
                    idempotencyKey: input.context.idempotencyKey,
                });
                return docRef.slice(docRef.indexOf("/") + 1);
            },
        }),
    );

    // After `registerAll`, and before anything can take a Turn: the catalogue is read from the
    // store once per Turn, and a Turn against an empty one throws.
    const catalogue = seedCatalogue(registry);
    // A reused store already has the catalogue in it — a restart is a second Runtime over the same
    // data, and seeding again would give it seventeen duplicate Operations.
    if (!options.store) putCatalogue(store, catalogue);

    const watcher = new Watcher({
        things,
        driver,
        maxBirthsPerHour: options.maxBirthsPerHour ?? 100,
        scheduleTimezone: options.scheduleTimezone ?? "Europe/Berlin",
        birth: birthConversation,
    });

    return {
        store,
        things,
        registry,
        catalogue,
        driver,
        watcher,
        firefly,
        async seedAssistant(overrides = {}) {
            const seed = ASSISTANT_SEEDS[0]!;
            return things.create<Record<string, unknown>>(SPECS.Assistant_DM, {
                key: seed.key,
                name: seed.name,
                systemPrompt: "You are a test assistant.",
                llmModel: "test",
                enabled: true,
                maxTurns: 20,
                skills: [],
                triggers: [{ kind: "thing-materialised", modelFilter: "Document_DM" }],
                grants: seed.grants.map((operationKey) => ({ operationKey })),
                idempotencyKey: `assistant:${overrides.key ?? seed.key}`,
                ...overrides,
            }) as Promise<Stored<Assistant>>;
        },
        birth: (input) =>
            birthConversation({
                assistant: input.assistant,
                prompt: input.prompt ?? "Do the thing.",
                title: "test",
                subjectThingId: input.subjectThingId,
                subjectModel: input.subjectModel,
                scheduledFor: input.scheduledFor,
                idempotencyKey: `test:${Math.random()}`,
            }),
        conversation: (docRef) => things.get<Conversation>(SPECS.Conversation_DM, docRef),
        questions: () => things.search<OpenQuestion>(SPECS.OpenQuestion_DM, undefined, 100),
        async answer(questionId, answer) {
            const docRef = `OpenQuestion_DM/${questionId}`;
            const question = await things.get<Record<string, unknown>>(SPECS.OpenQuestion_DM, docRef);
            await things.update(SPECS.OpenQuestion_DM, docRef, {
                ...question.data,
                ...answer,
                answeredAt: answer.answeredAt ?? nowIso(),
            });
        },
    };
}

export { RUNTIME_STATE_KEY, SPECS, nowIso };
export type { GrantedOperation };
