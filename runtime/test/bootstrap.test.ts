/**
 * Loading what the system *is*.
 *
 * Three requirements meet here, which is why it is worth its own file: the seeded Assistants are a
 * **definition** and re-running bootstrap must apply an edited one; the RuntimeState singleton is
 * **live state** and re-running bootstrap must not touch it; and an Operation is **half of each** —
 * its mechanical mirror of the code is re-applied, and every field a human might have thought about
 * is not. Getting the second wrong would reset the global pause and the watermark; getting the third
 * wrong would let `just dev` disengage a kill switch the User set.
 */

import { describe, expect, it } from "vitest";
import { buildHarness, clearCatalogue, nowIso, SPECS } from "./support/harness.js";
import { bootstrap, setPaused } from "../src/bootstrap/bootstrap.js";
import { RUNTIME_STATE_KEY } from "../src/watcher/watcher.js";
import { ASSISTANT_SEEDS } from "../src/bootstrap/assistants.js";
import type { OperationImplementation } from "../src/operations/registry.js";
import type { Assistant, Operation, RuntimeState, Stored } from "../src/domain/types.js";

const RECEPTIONIST = ASSISTANT_SEEDS[0]!;

/**
 * The Operation the asymmetry cases push around: mutating, granted to no Assistant, so nothing
 * depends on it. `bookkeeping.createAccount` played this role until it became dynamic (ADR-0025) and
 * left `buildOperations`; `email.receive` is the built-in that fits now.
 */
const VICTIM = "email.receive";

async function storedAssistant(
    harness: ReturnType<typeof buildHarness>,
    key: string,
): Promise<Stored<Assistant>> {
    const found = await harness.things.search<Assistant>(SPECS.Assistant_DM, undefined, 100);
    const assistant = found.find((candidate) => candidate.data.key === key);
    if (!assistant) throw new Error(`no Assistant ${key}`);
    return assistant;
}

async function storedOperation(
    harness: ReturnType<typeof buildHarness>,
    key: string,
): Promise<Stored<Operation>> {
    const found = await harness.things.findByIdempotencyKey<Operation>(
        SPECS.Operation_DM,
        `operation:${key}`,
    );
    if (!found) throw new Error(`no Operation ${key}`);
    return found;
}

/** The registered Implementations with one seed edited — which is what a developer does. */
function withSeed(
    implementations: readonly OperationImplementation[],
    key: string,
    patch: Partial<OperationImplementation["seed"]>,
): OperationImplementation[] {
    return implementations.map((implementation) =>
        implementation.name === key
            ? { ...implementation, seed: { ...implementation.seed, ...patch } }
            : implementation,
    );
}

describe("bootstrap", () => {
    it("seeds the Assistants and the RuntimeState on an empty store", async () => {
        const harness = buildHarness([]);
        const result = await bootstrap(harness.things, harness.registry.all());

        expect(result.created).toContain(RECEPTIONIST.key);
        expect(result.created).toContain("runtime-state");
        const seeded = await storedAssistant(harness, RECEPTIONIST.key);
        expect(seeded.data.systemPrompt).toBe(RECEPTIONIST.systemPrompt);
    });

    it("applies an edited seed on a re-run, as the README says it does", async () => {
        // `bootstrap()` was create-if-absent only: it looked up the idempotency key and, on a hit,
        // did nothing — while reporting success. README's own table says "Re-run after editing the
        // seeded Assistant definitions", so the one documented way to apply an edit did not work,
        // and the only thing that did was `just clean` / `just demo-reset`, which destroys the books.
        const harness = buildHarness([]);
        await bootstrap(harness.things, harness.registry.all());

        // Somebody edits the prompt — in the UI, or in the seed and then re-runs.
        const before = await storedAssistant(harness, RECEPTIONIST.key);
        await harness.things.update(SPECS.Assistant_DM, before.docRef, {
            ...before.data,
            systemPrompt: "Rewritten by hand.",
            maxTurns: 99,
        });

        const result = await bootstrap(harness.things, harness.registry.all());

        expect(result.updated).toContain(RECEPTIONIST.key);
        const after = await storedAssistant(harness, RECEPTIONIST.key);
        expect(after.data.systemPrompt).toBe(RECEPTIONIST.systemPrompt);
        expect(after.data.maxTurns).toBe(RECEPTIONIST.maxTurns);
        // The same Thing, not a second one.
        expect(after.thingId).toBe(before.thingId);
        expect(await harness.things.search(SPECS.Assistant_DM, undefined, 100)).toHaveLength(
            ASSISTANT_SEEDS.length,
        );
    });

    it("leaves the RuntimeState alone, because it is state and not a definition", async () => {
        // Rewriting the singleton the way the Assistants are rewritten would disengage a `just pause`
        // and reset the watermark — re-queueing every Thing in the store as new work.
        const harness = buildHarness([]);
        await bootstrap(harness.things, harness.registry.all());

        await setPaused(harness.things, true);
        const watermark = nowIso(new Date(Date.now() - 600_000));
        const state = await harness.watcher.loadState();
        await harness.things.update(SPECS.RuntimeState_DM, state.docRef, {
            ...state.data,
            watermark,
        });

        const result = await bootstrap(harness.things, harness.registry.all());

        expect(result.kept).toContain("runtime-state");
        const after = await harness.things.search<RuntimeState>(SPECS.RuntimeState_DM, undefined, 2);
        expect(after[0]!.data.singletonKey).toBe(RUNTIME_STATE_KEY);
        expect(after[0]!.data.paused).toBe(true);
        expect(after[0]!.data.watermark).toBe(watermark);
    });

    it("creates one Operation per registered Implementation, switched on", async () => {
        // A stack that has never run `just bootstrap`: the harness puts a catalogue in the store
        // because `advance()` refuses an empty one, and creating it is the thing under test here.
        const harness = buildHarness([]);
        clearCatalogue(harness.store);
        const implementations = harness.registry.all();

        const result = await bootstrap(harness.things, implementations);

        expect(result.operationsCreated).toHaveLength(implementations.length);
        const catalogue = await harness.things.search<Operation>(SPECS.Operation_DM, undefined, 100);
        expect(catalogue).toHaveLength(implementations.length);
        const victim = await storedOperation(harness, VICTIM);
        const seed = implementations.find((one) => one.name === VICTIM)!.seed;
        expect(victim.data.key).toBe(VICTIM);
        expect(victim.data.name).toBe(seed.name);
        expect(victim.data.description).toBe(seed.description);
        expect(victim.data.enabled).toBe(true);
        expect(victim.data.mutating).toBe(true);
        // An object in the seed, text on the Thing — and the catalogue read parses it back.
        expect(JSON.parse(victim.data.parameters ?? "")).toEqual(seed.parameters);
    });

    it("re-applies the mechanical mirror of an edited seed, and creates no second Thing", async () => {
        const harness = buildHarness([]);
        clearCatalogue(harness.store);
        await bootstrap(harness.things, harness.registry.all());
        const before = await storedOperation(harness, VICTIM);

        const result = await bootstrap(
            harness.things,
            withSeed(harness.registry.all(), VICTIM, { system: "Bookkeeping (moved)" }),
        );

        expect(result.operationsCreated).toEqual([]);
        expect(result.operationsUpdated).toContain(VICTIM);
        const after = await storedOperation(harness, VICTIM);
        expect(after.data.system).toBe("Bookkeeping (moved)");
        expect(after.thingId).toBe(before.thingId);
    });

    it("writes nothing on a re-run that changes nothing, so UpdatedAt still means something", async () => {
        // `update()` stamps `updatedAt`, and the mirror was re-applied unconditionally — so every
        // `just dev` moved the timestamp on all seventeen Operations and reported seventeen
        // updates. `updatedAt` is what the audit trail rests on: it is meant to say when somebody
        // weakened an approval, not when bootstrap last ran.
        const harness = buildHarness([]);
        clearCatalogue(harness.store);
        await bootstrap(harness.things, harness.registry.all());
        const before = await storedOperation(harness, VICTIM);
        // Stamped by hand, below the store's one-second resolution, so the assertion cannot pass
        // merely because the two runs fell in the same second.
        const stamped = "2020-01-01T00:00:00";
        const raw = await harness.store.getDocument(before.docRef);
        await harness.store.modifyDocument(before.docRef, {
            Operation: { ...(raw.document["Operation"] as Record<string, unknown>), UpdatedAt: stamped },
        });
        const writesBefore = harness.store.writes.length;

        const result = await bootstrap(harness.things, harness.registry.all());

        expect(result.operationsUpdated).toEqual([]);
        expect(result.operationsCreated).toEqual([]);
        expect((await storedOperation(harness, VICTIM)).data.updatedAt).toBe(stamped);
        // Not one write against an Operation, rather than seventeen that changed nothing.
        expect(
            harness.store.writes
                .slice(writesBefore)
                .filter((write) => write.docRef.startsWith("Operation_DM/")),
        ).toEqual([]);
    });

    it("never re-applies the prose, and reports the divergence instead of resolving it", async () => {
        // The cost of the asymmetry, paid out loud. A developer who improves a description in the
        // seed does not reach a running system — and finds out from this list rather than by
        // wondering why the model still behaves the way it did.
        const harness = buildHarness([]);
        clearCatalogue(harness.store);
        await bootstrap(harness.things, harness.registry.all());

        const result = await bootstrap(
            harness.things,
            withSeed(harness.registry.all(), VICTIM, {
                description: "Add an account to the chart of accounts. Ask first if it looks odd.",
            }),
        );

        expect(result.divergedDescriptions).toEqual([
            `${harness.registry.get(VICTIM)!.seed.name} (${VICTIM})`,
        ]);
        const after = await storedOperation(harness, VICTIM);
        expect(after.data.description).toBe(
            harness.registry.get(VICTIM)!.seed.description,
        );
    });

    it("leaves a switched-off Operation switched off, and a hand-set approval set", async () => {
        // Both are the User's (ADR-0018, as amended). A kill switch that `just dev` disengages is
        // not a kill switch, and an approval a re-run removes is worse than one that was never there.
        const harness = buildHarness([]);
        clearCatalogue(harness.store);
        await bootstrap(harness.things, harness.registry.all());
        const before = await storedOperation(harness, VICTIM);
        await harness.things.update(SPECS.Operation_DM, before.docRef, {
            enabled: false,
            requiresApproval: true,
            name: "Create an account (renamed by hand)",
            notes: "Switched off while the chart is being tidied.",
            // Moved as well, and it is on the mechanical side of the line: without this the closing
            // assertion held whether or not bootstrap re-applied anything, because creation had
            // already written the seed's value and `update` merges.
            system: "Typed into the wrong field",
        });

        await bootstrap(harness.things, harness.registry.all());

        const after = await storedOperation(harness, VICTIM);
        expect(after.data.enabled).toBe(false);
        expect(after.data.requiresApproval).toBe(true);
        expect(after.data.name).toBe("Create an account (renamed by hand)");
        expect(after.data.notes).toBe("Switched off while the chart is being tidied.");
        // …while the mechanical half underneath the decision was re-applied all the same.
        expect(after.data.system).toBe(harness.registry.get(VICTIM)!.seed.system);
    });

    // A Dynamic Operation seed carrier (ADR-0025): source and the four decision fields on the seed,
    // never registered in the registry (that would be `ambiguous`), passed to bootstrap alongside the
    // built-ins the way `cli.ts` passes the seven Firefly Sources.
    const DYNAMIC = "bookkeeping.demo";
    function dynamicSeed(patch: Partial<OperationImplementation["seed"]> = {}): OperationImplementation {
        return {
            name: DYNAMIC,
            mutating: false,
            async execute() {
                throw new Error("dynamic operations run in the Operation Host");
            },
            seed: {
                name: "Demo",
                system: "Bookkeeping",
                kind: "connector",
                description: "A demo dynamic operation.",
                parameters: { type: "object", properties: {} },
                implementation: "dynamic",
                source: "function execute() { return 1; }",
                language: "typescript",
                egress: "bookkeeping",
                clientReadable: true,
                ...patch,
            },
        };
    }

    it("creates a dynamic Operation with its source, egress, language and clientReadable", async () => {
        const harness = buildHarness([]);
        clearCatalogue(harness.store);

        await bootstrap(harness.things, [...harness.registry.all(), dynamicSeed()]);

        const thing = await storedOperation(harness, DYNAMIC);
        expect(thing.data.implementation).toBe("dynamic");
        expect(thing.data.source).toBe("function execute() { return 1; }");
        expect(thing.data.language).toBe("typescript");
        expect(thing.data.egress).toBe("bookkeeping");
        expect(thing.data.clientReadable).toBe(true);
    });

    it("re-applies implementation, because it is a fact about how the Operation is built", async () => {
        const harness = buildHarness([]);
        clearCatalogue(harness.store);
        await bootstrap(harness.things, [...harness.registry.all(), dynamicSeed()]);

        // Someone edits the Thing to claim it is built-in — which is drift, not a decision.
        const before = await storedOperation(harness, DYNAMIC);
        await harness.things.update(SPECS.Operation_DM, before.docRef, { implementation: "built-in" });

        const result = await bootstrap(harness.things, [...harness.registry.all(), dynamicSeed()]);

        expect(result.operationsUpdated).toContain(DYNAMIC);
        expect((await storedOperation(harness, DYNAMIC)).data.implementation).toBe("dynamic");
    });

    it("never re-applies edited source, and reports the divergence by name", async () => {
        const harness = buildHarness([]);
        clearCatalogue(harness.store);
        await bootstrap(harness.things, [...harness.registry.all(), dynamicSeed()]);

        const result = await bootstrap(harness.things, [
            ...harness.registry.all(),
            dynamicSeed({ source: "function execute() { return 2; }" }),
        ]);

        expect(result.divergedSource).toEqual([`Demo (${DYNAMIC})`]);
        // The User's source stands; the seed's improvement reaches fresh installs only.
        expect((await storedOperation(harness, DYNAMIC)).data.source).toBe("function execute() { return 1; }");
    });

    it("does not report source divergence when the seed carries none (a built-in)", async () => {
        const harness = buildHarness([]);
        clearCatalogue(harness.store);
        await bootstrap(harness.things, harness.registry.all());
        const result = await bootstrap(harness.things, harness.registry.all());
        expect(result.divergedSource).toEqual([]);
    });
});
