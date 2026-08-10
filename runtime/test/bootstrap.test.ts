/**
 * Loading what the system *is*.
 *
 * Two opposite requirements meet here, which is why it is worth its own file: the seeded Assistants
 * are a **definition** and re-running bootstrap must apply an edited one, while the RuntimeState
 * singleton is **live state** and re-running bootstrap must not touch it. Getting the second wrong
 * would reset the global pause and the watermark.
 */

import { describe, expect, it } from "vitest";
import { buildHarness, nowIso, SPECS } from "./support/harness.js";
import { bootstrap, setPaused } from "../src/bootstrap/bootstrap.js";
import { RUNTIME_STATE_KEY } from "../src/watcher/watcher.js";
import { ASSISTANT_SEEDS } from "../src/bootstrap/assistants.js";
import type { Assistant, RuntimeState, Stored } from "../src/domain/types.js";

const RECEPTIONIST = ASSISTANT_SEEDS[0]!;

async function storedAssistant(
    harness: ReturnType<typeof buildHarness>,
    key: string,
): Promise<Stored<Assistant>> {
    const found = await harness.things.search<Assistant>(SPECS.Assistant_DM, undefined, 100);
    const assistant = found.find((candidate) => candidate.data.key === key);
    if (!assistant) throw new Error(`no Assistant ${key}`);
    return assistant;
}

describe("bootstrap", () => {
    it("seeds the Assistants and the RuntimeState on an empty store", async () => {
        const harness = buildHarness([]);
        const result = await bootstrap(harness.things);

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
        await bootstrap(harness.things);

        // Somebody edits the prompt — in the UI, or in the seed and then re-runs.
        const before = await storedAssistant(harness, RECEPTIONIST.key);
        await harness.things.update(SPECS.Assistant_DM, before.docRef, {
            ...before.data,
            systemPrompt: "Rewritten by hand.",
            maxTurns: 99,
        });

        const result = await bootstrap(harness.things);

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
        await bootstrap(harness.things);

        await setPaused(harness.things, true);
        const watermark = nowIso(new Date(Date.now() - 600_000));
        const state = await harness.watcher.loadState();
        await harness.things.update(SPECS.RuntimeState_DM, state.docRef, {
            ...state.data,
            watermark,
        });

        const result = await bootstrap(harness.things);

        expect(result.kept).toContain("runtime-state");
        const after = await harness.things.search<RuntimeState>(SPECS.RuntimeState_DM, undefined, 2);
        expect(after[0]!.data.singletonKey).toBe(RUNTIME_STATE_KEY);
        expect(after[0]!.data.paused).toBe(true);
        expect(after[0]!.data.watermark).toBe(watermark);
    });
});
