/** Wires a whole Runtime around the in-memory store, so tests can drive real scans and Turns. */

import { MemoryStore } from "./memory-store.js";
import { ThingRepository, SPECS, nowIso, toDocument } from "../../src/a12/things.js";
import type { A12Client } from "../../src/a12/client.js";
import { LoopDriver } from "../../src/loop/advance.js";
import { OperationRegistry, type GrantedOperation } from "../../src/operations/registry.js";
import { buildOperations } from "../../src/operations/implementations.js";
import { OperationHost } from "../../src/operations/dynamic/host.js";
import { loadBookkeepingSeeds } from "../../src/operations/bookkeepingSeeds.js";
import { Watcher, RUNTIME_STATE_KEY } from "../../src/watcher/watcher.js";
import { ScriptedProvider, type ScriptedStep } from "../../src/llm/scripted.js";
import type { FireflyConnector } from "../../src/connectors/firefly.js";
import type { DynamicOperationConfig } from "../../src/config.js";
import type { Assistant, Conversation, OpenQuestion, Operation, Stored } from "../../src/domain/types.js";
import { ASSISTANT_SEEDS } from "../../src/bootstrap/assistants.js";
import { FireflyFixture } from "./fireflyFixture.js";

/**
 * The Firefly HTTP fixture the dynamic bookkeeping Operations reach through the Operation Host
 * (ADR-0025). Set once per test file in `beforeAll` — `buildHarness` reads it, staying synchronous —
 * so a file that exercises bookkeeping starts the fixture and calls `useFirefly(fixture)`; one that
 * does not leaves it unset and the bookkeeping egress points nowhere (harmless unless executed).
 */
let activeFirefly: FireflyFixture | undefined;
export function useFirefly(fixture: FireflyFixture | undefined): void {
    activeFirefly = fixture;
}

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
    const builtIns = registry.all().map((implementation) => ({
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
    // The seven bookkeeping Operations are dynamic (ADR-0025): their Things carry Source and are not
    // registered in the registry (that would be `ambiguous`), so they are added to the catalogue here
    // the way bootstrap creates them — the two-source join resolves them through the Operation Host.
    const dynamic = loadBookkeepingSeeds().map((implementation) => ({
        key: implementation.name,
        name: implementation.seed.name,
        system: implementation.seed.system,
        kind: implementation.seed.kind,
        description: implementation.seed.description,
        parameters: JSON.stringify(implementation.seed.parameters),
        mutating: implementation.mutating,
        requiresApproval: implementation.seed.requiresApproval ?? false,
        enabled: true,
        implementation: implementation.seed.implementation,
        source: implementation.seed.source,
        language: implementation.seed.language,
        egress: implementation.seed.egress,
        clientReadable: implementation.seed.clientReadable,
    }));
    return [...builtIns, ...dynamic];
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
    /** The Firefly HTTP fixture the dynamic bookkeeping Operations reach, or an unstarted one. */
    firefly: FireflyFixture;
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
    // The Firefly the dynamic bookkeeping Operations reach, set by the test file (or an unstarted one).
    const firefly = activeFirefly ?? new FireflyFixture();
    const dynamicConfig: DynamicOperationConfig = {
        timeoutMs: 20_000,
        maxBodyBytes: 4 * 1024 * 1024,
        memoryMb: 128,
        cacheTtlMs: 300_000,
        egresses: { bookkeeping: { url: firefly.url, token: "test-token" } },
    };
    const registry = new OperationRegistry(new OperationHost(dynamicConfig));

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
            // Unused now that the seven bookkeeping Operations are dynamic (ADR-0025); removed from
            // OperationDeps in step 10. The registry reaches Firefly through the Operation Host instead.
            firefly: undefined as unknown as FireflyConnector,
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
