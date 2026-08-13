/**
 * Loading what the system **is**: the Operation catalogue, the two Assistants and the RuntimeState
 * singleton.
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
import type { OperationImplementation } from "../operations/registry.js";
import type { Operation } from "../domain/types.js";

export interface BootstrapReport {
    /** Assistants and the RuntimeState, by key. */
    created: string[];
    updated: string[];
    kept: string[];
    /** Operations, by key. */
    operationsCreated: string[];
    operationsUpdated: string[];
    /**
     * Operations whose stored description no longer says what the seed says — named, and left
     * exactly as they are. See the rule below.
     */
    divergedDescriptions: string[];
}

/**
 * Seed or re-seed the system's own definition.
 *
 * Three behaviours, not one, and they disagree on purpose:
 *
 *   - An **Assistant seed is a definition**. Re-running bootstrap applies an edited one, because
 *     that is what README says it does and the only alternative was `just clean`, which destroys the
 *     books. The consequence is worth knowing: an Assistant's prompt edited in the web application is
 *     overwritten by the next `just bootstrap`, and therefore by the next `just dev`.
 *   - The **RuntimeState is live state**. Re-running must not touch it, or a `just pause` would be
 *     disengaged and the watermark reset — re-queueing every Thing in the store as new work.
 *   - An **Operation is half code and half decision**, and this is the half a reader will not guess:
 *     *bootstrap re-applies what the code knows and never re-applies a decision.* `system`, `kind`,
 *     `parameters` and `mutating` are the mechanical mirror of an Implementation, so they are
 *     rewritten on every run. `name`, `description`, `requiresApproval`, `enabled` and `notes` are
 *     the User's: written once, at creation, and never again — a kill switch that `just dev`
 *     disengages is not a kill switch.
 *
 * **The prose is on the decision side of that line.** Rewording the sentence a model reads *in order
 * to change how it behaves* is a decision, not a fact about `execute`, so a developer who improves a
 * `description` in the seed does not reach a running system. That is a real cost and it is paid out
 * loud rather than hidden: every Operation whose stored description differs from its seed comes back
 * in {@link BootstrapReport.divergedDescriptions}, and nothing is changed.
 *
 * The Operation loop runs **first**, because a fresh stack needs a catalogue before it has an
 * Assistant granting from it.
 *
 * The Implementations are passed in rather than built here: only their seeds are wanted, and
 * constructing an executable one needs a Firefly connector and a live Conversation to ask questions
 * of — neither of which bootstrap has any business holding.
 */
export async function bootstrap(
    things: ThingRepository,
    implementations: readonly OperationImplementation[],
): Promise<BootstrapReport> {
    const created: string[] = [];
    const updated: string[] = [];
    const kept: string[] = [];
    const operationsCreated: string[] = [];
    const operationsUpdated: string[] = [];
    const divergedDescriptions: string[] = [];

    for (const implementation of implementations) {
        const seed = implementation.seed;
        const key = `operation:${implementation.name}`;
        // The mechanical mirror, and nothing else. `ThingRepository.update` merges onto the raw
        // stored document, so these four are exactly enough to leave the other five alone — the
        // same property `setPaused` relies on.
        const mirror = {
            system: seed.system,
            kind: seed.kind,
            parameters: JSON.stringify(seed.parameters),
            mutating: implementation.mutating,
        };
        const existing = await things.findByIdempotencyKey<Operation>(SPECS.Operation_DM, key);
        if (existing) {
            await things.update(SPECS.Operation_DM, existing.docRef, mirror);
            operationsUpdated.push(implementation.name);
            if ((existing.data.description ?? "") !== seed.description) {
                // The name the User sees in the catalogue — the stored one, which a rename may have
                // moved away from the seed — with the key beside it, so whoever edited the seed
                // knows which Implementation it was.
                const shown = existing.data.name || seed.name;
                divergedDescriptions.push(`${shown} (${implementation.name})`);
            }
            continue;
        }
        await things.create<Record<string, unknown>>(SPECS.Operation_DM, {
            key: implementation.name,
            name: seed.name,
            description: seed.description,
            ...mirror,
            requiresApproval: seed.requiresApproval ?? false,
            // A newly created Operation is switched on. Nobody has decided otherwise yet.
            enabled: true,
            idempotencyKey: key,
        });
        operationsCreated.push(implementation.name);
    }

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

    return { created, updated, kept, operationsCreated, operationsUpdated, divergedDescriptions };
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
