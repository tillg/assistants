/**
 * The Runtime's entry point: scan, act, sleep, repeat.
 *
 * No queue and no scheduler — the ThingStore is the only Authority for **pending work**, so scanning
 * it is all there is to do (D-005). A crash here is a non-event: everything the Runtime knows is
 * already written down.
 *
 * There is now one other thing, and it does not touch that sentence. When `INBOUND_PORT` is set, the
 * Runtime opens **the door outward** (ADR-0023): a read-only route that lets the client ask for an
 * allowed Operation to be executed against an External System, because the Runtime is the only
 * component that can reach one. It carries no pending work, answers no question about what is
 * waiting, and keeps nothing between requests. Unset — the default — and nothing listens at all.
 */

import { loadConfig } from "./config.js";
import { startInbox, type Inbox } from "./inbound/server.js";
import { ConfigurationError } from "./llm/profiles.js";
import { describeError, log } from "./log.js";
import { buildRuntime } from "./services.js";
import { sleep } from "./loop/advance.js";

async function main(): Promise<void> {
    const config = loadConfig();
    log.info("runtime starting", {
        thingStore: config.thingStoreUrl,
        firefly: config.fireflyUrl,
        // Which model it is about to talk to is logged by `buildRuntime`, once the profile named
        // in this file has been resolved and its key found.
        llmConfigFile: config.llmConfigFile,
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

    let inbox: Inbox | undefined;
    if (config.inboundPort > 0) {
        inbox = await startInbox({
            port: config.inboundPort,
            secret: config.inboundSecret,
            allowlist: config.clientCallable,
            registry: runtime.registry,
            things: runtime.things,
        });
    }

    let stopping = false;
    const stop = (signal: string) => {
        log.info(`received ${signal}, finishing the current scan and stopping`);
        stopping = true;
        // Closed here rather than after the loop: an open listener keeps the event loop alive, so a
        // Runtime that only set the flag would go on running until compose lost patience and killed
        // it. The scan loop's own exit is what ends the process; this is what lets it.
        void inbox?.close().catch((error: unknown) => {
            log.warn("the door outward did not close cleanly", { error: describeError(error) });
        });
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
    // A misconfiguration is not a crash, and its message is the only useful thing in the log: it
    // says which profile, in which file, needs which variable. Printed as it was written, rather
    // than escaped into a JSON field behind a stack trace nobody in this position can use.
    if (error instanceof ConfigurationError) {
        process.stderr.write(`\n${error.message}\n\n`);
        process.exitCode = 1;
        return;
    }
    log.error("runtime crashed", { error: describeError(error) });
    process.exitCode = 1;
});
