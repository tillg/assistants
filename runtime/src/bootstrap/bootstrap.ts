/**
 * Loading what the system **is**: the two Assistants and the RuntimeState singleton.
 *
 * Deliberately separate from the demo data, which loads what the household *has*. Two kinds of
 * data with two different lifetimes: without this split, `demo-reset` would delete the system's
 * behaviour along with the fixtures, and a fresh stack would be inert.
 *
 * Kept apart from `cli.ts` so that importing these functions does not run a command-line entry
 * point as a side effect.
 */

import { log } from "../log.js";
import { eq, nowIso, path as fieldPath, SPECS, ThingRepository } from "../a12/things.js";
import { ASSISTANT_SEEDS } from "./assistants.js";
import { RUNTIME_STATE_KEY } from "../watcher/watcher.js";

export async function bootstrap(things: ThingRepository): Promise<{ created: string[]; kept: string[] }> {
    const created: string[] = [];
    const kept: string[] = [];

    for (const seed of ASSISTANT_SEEDS) {
        const key = `assistant:${seed.key}`;
        const existing = await things.findByIdempotencyKey(SPECS.Assistant_DM, key);
        if (existing) {
            kept.push(seed.key);
            continue;
        }
        await things.create<Record<string, unknown>>(SPECS.Assistant_DM, {
            key: seed.key,
            name: seed.name,
            description: seed.description,
            systemPrompt: seed.systemPrompt,
            llmModel: seed.llmModel,
            enabled: seed.enabled,
            maxTurns: seed.maxTurns,
            skills: seed.skills,
            triggers: seed.triggers,
            tools: seed.tools.map((operation) => ({ operation })),
            idempotencyKey: key,
        });
        created.push(seed.key);
    }

    const stateKey = `runtime-state:${RUNTIME_STATE_KEY}`;
    const state = await things.findByIdempotencyKey(SPECS.RuntimeState_DM, stateKey);
    if (state) {
        kept.push("runtime-state");
    } else {
        await things.create<Record<string, unknown>>(SPECS.RuntimeState_DM, {
            singletonKey: RUNTIME_STATE_KEY,
            paused: false,
            birthsThisHour: 0,
            birthWindowStartedAt: nowIso(),
            // A fresh system should not treat pre-existing Things as brand new work.
            watermark: nowIso(),
            idempotencyKey: stateKey,
        });
        created.push("runtime-state");
    }

    return { created, kept };
}

/** Set or clear the global kill switch. Used by `just pause` / `just resume` and the demo loader. */
export async function setPaused(things: ThingRepository, paused: boolean): Promise<void> {
    const found = await things.search<Record<string, unknown>>(
        SPECS.RuntimeState_DM,
        eq(fieldPath(SPECS.RuntimeState_DM, "singletonKey"), RUNTIME_STATE_KEY),
        2,
    );
    const state = found[0];
    if (!state) throw new Error("No RuntimeState — run `just bootstrap` first.");
    await things.update(SPECS.RuntimeState_DM, state.docRef, { ...state.data, paused });
}
