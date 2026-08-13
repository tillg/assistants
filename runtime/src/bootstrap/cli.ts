/**
 * `just bootstrap` — load the Operation catalogue, the Assistants and the RuntimeState. Also
 * `pause` / `resume`.
 *
 * This runs as the **User**, not as the Runtime. An Assistant is the User's to write and the
 * Runtime's to read, and since D-007a the ThingStore enforces that instead of merely documenting
 * it: the `runtime` role has no `ASSISTANT_WRITE`, so seeding as the Runtime answers -32059. An
 * Operation is the User's in the same way. The kill switch (`pause` / `resume`) is a User action
 * too, and touches only the `RuntimeState`.
 */

import { loadConfig } from "../config.js";
import { describeError, log } from "../log.js";
import { A12Client } from "../a12/client.js";
import { ThingRepository } from "../a12/things.js";
import { FireflyConnector } from "../connectors/firefly.js";
import { buildOperations } from "../operations/implementations.js";
import { sleep } from "../loop/advance.js";
import { bootstrap, setPaused } from "./bootstrap.js";

async function main(): Promise<void> {
    const config = loadConfig();
    const client = new A12Client({
        baseUrl: config.thingStoreUrl,
        username: config.bootstrapUser,
        password: config.bootstrapPassword,
        keycloakUrl: config.keycloakUrl,
        keycloakRealm: config.keycloakRealm,
        keycloakClientId: config.keycloakClientId,
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
    if (argument !== undefined) {
        // A typo in the kill-switch command used to fall through to a full bootstrap and report
        // success — `pausee` did the opposite of pausing, cheerfully.
        throw new Error(`Unknown argument "${argument}". Expected "pause", "resume", or nothing.`);
    }

    // Bootstrap wants the seeds, which live beside the code they describe. Building the
    // Implementations is the only way to reach them, and it costs nothing here: `buildOperations`
    // touches none of its dependencies until an Operation actually runs, and bootstrap never runs
    // one. The two that would need a live Conversation say so rather than pretending.
    const operations = buildOperations({
        things,
        firefly: new FireflyConnector(
            config.fireflyUrl,
            config.fireflyToken,
            config.fireflyTokenFile,
            config.uiBaseUrl,
        ),
        raiseQuestion: () => {
            throw new Error("bootstrap does not execute Operations");
        },
        callAssistant: () => {
            throw new Error("bootstrap does not execute Operations");
        },
    });

    const result = await bootstrap(things, operations);
    log.info("bootstrap complete", {
        created: result.created,
        updated: result.updated,
        alreadyPresent: result.kept,
        operationsCreated: result.operationsCreated.length,
        operationsUpdated: result.operationsUpdated.length,
    });
    if (result.divergedDescriptions.length > 0) {
        // Not an error and not a nag: the stored prose is the User's, and this is the one place the
        // stickiness is visible instead of mysterious. A developer who edited a seed description
        // reads this line and knows why the running system did not change.
        log.warn(
            "these Operations describe themselves differently from their seed; bootstrap changed nothing",
            { operations: result.divergedDescriptions },
        );
    }
}

main().catch((error: unknown) => {
    log.error("bootstrap failed", { error: describeError(error) });
    process.exitCode = 1;
});
