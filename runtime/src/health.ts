/**
 * The container health probe.
 *
 * Deliberately **not** "is the process alive". The Runtime's failure mode that matters is a
 * wedged or throwing scan loop: the process stays up, nothing happens, and the User cannot tell
 * that from "nothing needed to happen". The terminal-failure path cannot report it either,
 * because raising an Open Question is itself a ThingStore write and shares fate with whatever
 * broke.
 *
 * So health is: **did the last scan finish recently**, read from `RuntimeState.heartbeatAt`.
 * A scan that throws leaves the heartbeat untouched, and this goes unhealthy.
 */

import { loadConfig } from "./config.js";
import { A12Client } from "./a12/client.js";
import { eq, parseIso, path as fieldPath, SPECS, ThingRepository } from "./a12/things.js";
import { RUNTIME_STATE_KEY } from "./watcher/watcher.js";
import type { RuntimeState } from "./domain/types.js";

const STALE_AFTER_MS = 90_000;

async function main(): Promise<void> {
    const config = loadConfig();
    const client = new A12Client({
        baseUrl: config.thingStoreUrl,
        username: config.thingStoreUser,
        password: config.thingStorePassword,
        locale: config.locale,
    });
    const things = new ThingRepository(client);

    const found = await things.search<RuntimeState>(
        SPECS.RuntimeState_DM,
        eq(fieldPath(SPECS.RuntimeState_DM, "singletonKey"), RUNTIME_STATE_KEY),
        2,
    );
    const state = found[0];
    if (!state) {
        // Not yet bootstrapped. Healthy: there is nothing to have failed at.
        process.stdout.write("no runtime state yet\n");
        return;
    }

    if (state.data.paused) {
        process.stdout.write("paused\n");
        return;
    }

    const heartbeat = parseIso(state.data.heartbeatAt);
    if (heartbeat === undefined) {
        process.stdout.write("no heartbeat yet\n");
        return;
    }

    const age = Date.now() - heartbeat;
    if (age > STALE_AFTER_MS) {
        process.stderr.write(`heartbeat is ${Math.round(age / 1000)}s old — the watcher is stuck\n`);
        process.exitCode = 1;
        return;
    }
    process.stdout.write(`ok, heartbeat ${Math.round(age / 1000)}s old\n`);
}

main().catch((error: unknown) => {
    process.stderr.write(`health check failed: ${String(error)}\n`);
    process.exitCode = 1;
});
