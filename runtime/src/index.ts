/**
 * The Runtime's entry point: scan, act, sleep, repeat.
 *
 * There is nothing else. No HTTP server, no queue, no scheduler — the ThingStore is the only
 * Authority for pending work, so scanning it is all there is to do (D-005). A crash here is a
 * non-event: everything the Runtime knows is already written down.
 */

import { loadConfig } from "./config.js";
import { describeError, log } from "./log.js";
import { buildRuntime } from "./services.js";
import { sleep } from "./loop/advance.js";

async function main(): Promise<void> {
    const config = loadConfig();
    log.info("runtime starting", {
        thingStore: config.thingStoreUrl,
        firefly: config.fireflyUrl,
        llmProvider: config.llmProvider,
        scanIntervalMs: config.scanIntervalMs,
    });

    const runtime = buildRuntime(config);

    // Wait for the ThingStore rather than crash-looping against it while the stack comes up.
    for (let attempt = 1; ; attempt += 1) {
        if (await runtime.client.isReachable()) break;
        if (attempt % 15 === 0) log.info("still waiting for the ThingStore", { attempt });
        await sleep(2000);
    }
    await runtime.client.login();
    log.info("connected to the ThingStore");

    let stopping = false;
    const stop = (signal: string) => {
        log.info(`received ${signal}, finishing the current scan and stopping`);
        stopping = true;
    };
    process.on("SIGTERM", () => stop("SIGTERM"));
    process.on("SIGINT", () => stop("SIGINT"));

    let consecutiveFailures = 0;
    while (!stopping) {
        try {
            const report = await runtime.watcher.scan();
            consecutiveFailures = 0;
            if (report.births > 0 || report.continuations > 0) {
                log.info("scan did work", {
                    births: report.births,
                    continuations: report.continuations,
                });
            }
        } catch (error) {
            consecutiveFailures += 1;
            // Deliberately does NOT stamp the heartbeat: silence has to be recorded silence, and a
            // stale heartbeat is what the compose healthcheck and the User both look at.
            //
            // A broken store fails every scan, so at one line per two seconds the log becomes
            // unreadable exactly when someone needs to read it. Full detail on the first failure
            // and then once a minute; a single line in between.
            const noisy = consecutiveFailures === 1 || consecutiveFailures % 30 === 0;
            if (noisy) {
                log.error("scan failed", { consecutiveFailures, error: describeError(error) });
            } else {
                log.warn("scan failed again", { consecutiveFailures });
            }
        }
        await sleep(config.scanIntervalMs);
    }

    log.info("runtime stopped");
}

main().catch((error: unknown) => {
    log.error("runtime crashed", { error: describeError(error) });
    process.exitCode = 1;
});
