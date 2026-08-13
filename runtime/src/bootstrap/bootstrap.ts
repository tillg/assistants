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

/**
 * Seed or re-seed the system's own definition.
 *
 * The two halves are deliberately asymmetric. An **Assistant seed is a definition**: re-running
 * bootstrap applies an edited one, because that is what README says it does and the only alternative
 * was `just clean`, which destroys the books. The **RuntimeState is live state**: re-running must not
 * touch it, or a `just pause` would be disengaged and the watermark reset — re-queueing every Thing
 * in the store as new work.
 *
 * The consequence of the first half is worth knowing: an Assistant's prompt edited in the web
 * application is overwritten by the next `just bootstrap`, and therefore by the next `just dev`. The
 * seed is the source of truth; that is what makes it reproducible.
 */
export async function bootstrap(
    things: ThingRepository,
): Promise<{ created: string[]; updated: string[]; kept: string[] }> {
    const created: string[] = [];
    const updated: string[] = [];
    const kept: string[] = [];

    for (const seed of ASSISTANT_SEEDS) {
        const key = `assistant:${seed.key}`;
        const fields = {
            key: seed.key,
            name: seed.name,
            description: seed.description,
            systemPrompt: seed.systemPrompt,
            llmModel: seed.llmModel,
            enabled: seed.enabled,
            maxTurns: seed.maxTurns,
            skills: seed.skills,
            triggers: seed.triggers,
            grants: seed.grants.map((operationKey) => ({ operationKey })),
            idempotencyKey: key,
        };
        const existing = await things.findByIdempotencyKey<Record<string, unknown>>(
            SPECS.Assistant_DM,
            key,
        );
        if (existing) {
            // `ThingRepository.update` merges onto the raw stored document, so anything the seed does
            // not describe survives.
            await things.update(SPECS.Assistant_DM, existing.docRef, fields);
            updated.push(seed.key);
            continue;
        }
        await things.create<Record<string, unknown>>(SPECS.Assistant_DM, fields);
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

    return { created, updated, kept };
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
    // ONLY `paused`. Writing the whole document back would revert whatever the scan advanced between
    // the read above and this write — the watermark in particular, and rolling that back re-queues
    // every Thing behind it. The exact mirror of BUG-07, which was the scan trampling this field.
    await things.update(SPECS.RuntimeState_DM, state.docRef, { paused });
}

/** Is the Runtime currently paused? Used by the demo loader so it can restore what it found. */
export async function isPaused(things: ThingRepository): Promise<boolean> {
    const found = await things.search<Record<string, unknown>>(
        SPECS.RuntimeState_DM,
        eq(fieldPath(SPECS.RuntimeState_DM, "singletonKey"), RUNTIME_STATE_KEY),
        2,
    );
    return found[0]?.data["paused"] === true;
}
