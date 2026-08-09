/**
 * `just bootstrap` — load the Assistants and the RuntimeState. Also `pause` / `resume`.
 */

import { loadConfig } from "../config.js";
import { describeError, log } from "../log.js";
import { A12Client } from "../a12/client.js";
import { ThingRepository } from "../a12/things.js";
import { sleep } from "../loop/advance.js";
import { bootstrap, setPaused } from "./bootstrap.js";

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
    if (argument !== undefined) {
        // A typo in the kill-switch command used to fall through to a full bootstrap and report
        // success — `pausee` did the opposite of pausing, cheerfully.
        throw new Error(`Unknown argument "${argument}". Expected "pause", "resume", or nothing.`);
    }

    const result = await bootstrap(things);
    log.info("bootstrap complete", { created: result.created, alreadyPresent: result.kept });
}

main().catch((error: unknown) => {
    log.error("bootstrap failed", { error: describeError(error) });
    process.exitCode = 1;
});
