/**
 * `bootstrap()` against the live store: the catalogue, and the asymmetry that governs re-running it.
 *
 * Worth an integration test rather than a unit one because the interesting half is what the *store*
 * does with a partial update. `ThingRepository.update` merges onto the raw stored document, so
 * writing only the four mechanical fields is what leaves the other five alone — and that is a
 * property of `MODIFY_DOCUMENT`, not of our projection. An in-memory test asserting it is asserting
 * the memory store's merge, which is the thing that could disagree.
 *
 * Two things this suite does to the running stack, deliberately and on the record:
 *
 *   1. It runs the **real** `bootstrap()`, so it also re-seeds the Assistants and leaves the
 *      RuntimeState alone — exactly what `just bootstrap` does before every `just dev`. A prompt
 *      hand-edited in the web application is overwritten either way; nothing new is destroyed here.
 *   2. The seed-divergence cases need an Operation whose stored fields can be pushed around, so they
 *      use `bookkeeping.createAccount` — the one Implementation granted to **no** Assistant (see
 *      ACCOUNTANT's grants), so switching it off for the length of a test cannot strand a Turn. Each
 *      case restores what it changed, and a final pristine run heals anything a failure left behind.
 *
 * Bootstrap runs as the **User** (D-007a): the `runtime` role has no `ASSISTANT_WRITE`, and
 * `Operation_DM` is User-owned too, so seeding as the Runtime would answer -32059.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SPECS, ThingRepository } from "../../src/a12/things.js";
import { bootstrap } from "../../src/bootstrap/bootstrap.js";
import { buildOperations } from "../../src/operations/implementations.js";
import type { OperationImplementation } from "../../src/operations/registry.js";
import type { Operation, Stored } from "../../src/domain/types.js";
import { newFirefly, newJanitor, newThings, THING_STORE_UP } from "./support/live.js";

/** The Operation the divergence cases push around. Granted to nobody, so nothing depends on it. */
const VICTIM = "bookkeeping.createAccount";

describe.skipIf(!THING_STORE_UP)("bootstrap against the live ThingStore", () => {
    let things: ThingRepository;
    let implementations: OperationImplementation[];

    beforeAll(async () => {
        // The User, not the Runtime: `Operation_DM` and `Assistant_DM` are the User's to write.
        const janitor = newJanitor();
        await janitor.login();
        things = newThings(janitor);
        implementations = buildOperations({
            things,
            firefly: newFirefly(),
            // Bootstrap reads seeds; it never executes an Operation, and neither of these can exist
            // without a live Conversation. Saying so beats handing them something that pretends.
            raiseQuestion: () => {
                throw new Error("bootstrap does not execute Operations");
            },
            callAssistant: () => {
                throw new Error("bootstrap does not execute Operations");
            },
        });
        await bootstrap(things, implementations);
    });

    afterAll(async () => {
        // Whatever a failed case left behind, a pristine run re-applies the mechanical mirror and a
        // hand-write restores the two fields bootstrap will never touch again.
        await bootstrap(things, implementations);
        await restoreVictim();
    });

    async function stored(key: string): Promise<Stored<Operation>> {
        const found = await things.findByIdempotencyKey<Operation>(
            SPECS.Operation_DM,
            `operation:${key}`,
        );
        if (!found) throw new Error(`no Operation ${key}`);
        return found;
    }

    /** Put the User-owned half of the victim back the way a fresh bootstrap would have created it. */
    async function restoreVictim(): Promise<void> {
        const seed = seedOf(VICTIM);
        const current = await stored(VICTIM);
        await things.update(SPECS.Operation_DM, current.docRef, {
            name: seed.name,
            description: seed.description,
            requiresApproval: seed.requiresApproval ?? false,
            enabled: true,
        });
    }

    function seedOf(key: string): OperationImplementation["seed"] {
        const implementation = implementations.find((candidate) => candidate.name === key);
        if (!implementation) throw new Error(`no Implementation ${key}`);
        return implementation.seed;
    }

    /** The same list of Implementations with one seed edited — which is what a developer does. */
    function withSeed(
        key: string,
        patch: Partial<OperationImplementation["seed"]>,
    ): OperationImplementation[] {
        return implementations.map((implementation) =>
            implementation.name === key
                ? { ...implementation, seed: { ...implementation.seed, ...patch } }
                : implementation,
        );
    }

    it("creates one Operation per registered Implementation", async () => {
        // `beforeAll` already ran it. On a stack that has been bootstrapped once these are updates
        // rather than creations, so the assertion is about the catalogue, not about the verb.
        for (const implementation of implementations) {
            const thing = await stored(implementation.name);
            expect(thing.data.key).toBe(implementation.name);
            expect(thing.data.name).toBe(implementation.seed.name);
            expect(thing.data.system).toBe(implementation.seed.system);
            expect(thing.data.kind).toBe(implementation.seed.kind);
            expect(thing.data.mutating).toBe(implementation.mutating);
            // The schema is an object in the seed and text on the Thing; the catalogue read parses
            // it back, so it has to be JSON the parser accepts.
            expect(JSON.parse(thing.data.parameters ?? "")).toEqual(implementation.seed.parameters);
            expect(thing.data.enabled).not.toBe(false);
        }
    });

    it("re-applies an edited seed `system`, because that is a fact about the code", async () => {
        const before = await stored(VICTIM);

        const result = await bootstrap(things, withSeed(VICTIM, { system: "Bookkeeping (moved)" }));

        expect(result.operationsUpdated).toContain(VICTIM);
        const after = await stored(VICTIM);
        expect(after.data.system).toBe("Bookkeeping (moved)");
        // The same Thing, not a second one.
        expect(after.thingId).toBe(before.thingId);

        await bootstrap(things, implementations);
        expect((await stored(VICTIM)).data.system).toBe(seedOf(VICTIM).system);
    });

    it("leaves a diverged description alone, and reports it rather than resolving it", async () => {
        // The User rewords the sentence the model reads. That is a decision, and bootstrap does not
        // re-apply a decision — but it must not be silent about the drift either.
        const before = await stored(VICTIM);
        const edited = "Add an account to the chart of accounts. Ask first if it looks like a typo.";
        await things.update(SPECS.Operation_DM, before.docRef, { description: edited });

        const result = await bootstrap(things, implementations);

        expect((await stored(VICTIM)).data.description).toBe(edited);
        expect(result.divergedDescriptions).toContain(`Create an account (${VICTIM})`);

        await restoreVictim();
        expect((await bootstrap(things, implementations)).divergedDescriptions).not.toContain(
            `Create an account (${VICTIM})`,
        );
    });

    it("leaves a switched-off Operation switched off, and a hand-set approval set", async () => {
        // Both are the User's, and both would be undone by a bootstrap that wrote the whole seed
        // back — a kill switch that `just dev` disengages is not a kill switch.
        const before = await stored(VICTIM);
        await things.update(SPECS.Operation_DM, before.docRef, {
            enabled: false,
            requiresApproval: true,
            name: "Create an account (renamed by hand)",
            notes: "Switched off by the integration suite.",
        });

        await bootstrap(things, implementations);

        const after = await stored(VICTIM);
        expect(after.data.enabled).toBe(false);
        expect(after.data.requiresApproval).toBe(true);
        expect(after.data.name).toBe("Create an account (renamed by hand)");
        expect(after.data.notes).toBe("Switched off by the integration suite.");
        // …while the mechanical half was still re-applied underneath the decision.
        expect(after.data.system).toBe(seedOf(VICTIM).system);

        await restoreVictim();
        await things.update(SPECS.Operation_DM, after.docRef, { notes: "" });
        expect((await stored(VICTIM)).data.enabled).toBe(true);
    });
});
