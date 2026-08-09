/*
 * SPDX-License-Identifier: EUPL-1.2 OR LicenseRef-commercial
 *
 * Copyright (c) 2012-2026 mgm technology partners GmbH
 *
 * Dual License
 * ------------
 * This source file is part of the mgm A12 Platform and available under
 * a choice of two different licenses:
 *
 * 1. Open-Source License - EUPL v1.2
 *    You may redistribute and/or modify this file under the terms of the
 *    European Union Public License, version 1.2 - see https://eupl.eu/.
 *
 * 2. Commercial License
 *    Alternatively, you may obtain a commercial license from
 *    mgm technology partners GmbH, that permits use of this software
 *    under different terms (including support and maintenance services).
 *
 *    Please contact a12-license@mgm-tp.com for more information.
 *
 * You must select and comply with exactly one of the above license options.
 *
 * Warranty Disclaimer (applies to either option)
 * ----------------------------------------------
 * THIS SOFTWARE IS PROVIDED "AS IS" AND WITHOUT WARRANTY OF ANY KIND,
 * WHETHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
 * OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NON-INFRINGEMENT, EXCEPT WHERE SUCH DISCLAIMERS ARE HELD TO BE
 * LEGALLY INVALID. SEE THE RESPECTIVE LICENSE TEXT FOR DETAILS.
 */

/**
 * Driving the stack from a test, which only the ADR-0004 restart test needs.
 *
 * Restarting is the whole point of that test: if waiting were a running process, killing the
 * process would lose the wait. It is not, so it does not.
 */

import { execFileSync } from "node:child_process";

import { BASE_URL, COMPOSE_ARGS, REPO_ROOT, THINGSTORE_URL } from "./config";
import { sleep } from "./thingstore";

/** `docker compose … restart <services>` — the same invocation `just restart` uses. */
export function restartServices(services: string[]): void {
    execFileSync("docker", [...COMPOSE_ARGS, "restart", ...services], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 180_000
    });
}

async function responds(url: string): Promise<boolean> {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
        return response.ok;
    } catch {
        return false;
    }
}

/** Wait until the ThingStore and the UserInterface answer again — what `just wait` does. */
export async function waitForStack(timeoutMs = 240_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if ((await responds(`${THINGSTORE_URL}/actuator/health`)) && (await responds(BASE_URL))) {
            return;
        }
        await sleep(2_000);
    }
    throw new Error(`The stack did not come back within ${timeoutMs} ms — try \`just logs\`.`);
}
