/**
 * `just bootstrap` — load what the system **is**.
 *
 * Deliberately separate from `just demo-data`, which loads what the household *has*. Two kinds of
 * data with two different lifetimes: without this split, `demo-reset` would delete the system's
 * behaviour along with the fixtures, and a fresh stack would be inert — no Assistant, no trigger
 * can match, nothing happens, and an empty Open Questions view that looks like a bug.
 *
 * Idempotent: everything carries a stable `idempotencyKey`, so re-running never overwrites a
 * prompt the User has edited.
 */

import { loadConfig } from "../config.js";
import { describeError, log } from "../log.js";
import { eq, nowIso, path as fieldPath, SPECS, ThingRepository } from "../a12/things.js";
import { A12Client } from "../a12/client.js";
import { ASSISTANT_SEEDS } from "./assistants.js";
import { RUNTIME_STATE_KEY } from "../watcher/watcher.js";
import { sleep } from "../loop/advance.js";

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

async function main(): Promise<void> {
    const config = loadConfig();
    const client = new A12Client({
        baseUrl: config.thingStoreUrl,
        username: config.thingStoreUser,
        password: config.thingStorePassword,
        locale: config.locale,
    });

    for (let attempt = 1; attempt <= 90; attempt += 1) {
        if (await client.isReachable()) break;
        if (attempt === 90) throw new Error(`ThingStore never became reachable at ${config.thingStoreUrl}`);
        await sleep(2000);
    }
    await client.login();

    const things = new ThingRepository(client);
    const argument = process.argv[2];
    if (argument === "pause" || argument === "resume") {
        await setPaused(things, argument === "pause");
        log.info(`runtime ${argument}d`);
        return;
    }

    const result = await bootstrap(things);
    log.info("bootstrap complete", { created: result.created, alreadyPresent: result.kept });
}

main().catch((error: unknown) => {
    log.error("bootstrap failed", { error: describeError(error) });
    process.exitCode = 1;
});
