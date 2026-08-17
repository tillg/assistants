/*
 * SPDX-License-Identifier: EUPL-1.2
 *
 * Copyright (c) 2026 Till Gartner
 * Copyright (c) 2012-2026 mgm technology partners GmbH
 *
 * Part of Assistants. Derived from the mgm A12 project template, which mgm
 * licenses as EUPL-1.2 or commercial; Assistants takes the EUPL-1.2 option,
 * so this file is distributed here under EUPL-1.2 only.
 *
 * Licensed under the European Union Public Licence, version 1.2 - see
 * https://eupl.eu/ and the LICENSE file at the root of this repository.
 * Distributed on an "AS IS" basis, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.
 */

import { defineConfig, devices } from "@playwright/test";

import { BASE_URL } from "./utils/config";

export default defineConfig({
    testDir: "./tests",
    forbidOnly: !!process.env.CI,
    fullyParallel: true,
    retries: process.env.CI ? 1 : 0,
    workers: process.env.CI ? 3 : undefined,
    reporter: "html",
    use: {
        headless: true,
        viewport: { width: 1200, height: 660 },
        baseURL: BASE_URL,
        testIdAttribute: "data-role",
        trace: "on-first-retry"
    },
    timeout: 60_000,
    expect: {
        timeout: 10_000
    },
    projects: [
        {
            name: "base",
            use: { ...devices["Desktop Chrome"], channel: "chromium" },
            testDir: "./tests/base",
            dependencies: ["setup-base"]
        },
        {
            name: "setup-base",
            use: { ...devices["Desktop Chrome"], channel: "chromium" },
            testDir: "./tests/base",
            testMatch: /0-clean\.setup\.ts/,
            dependencies: ["setup-auth"]
        },

        // The two flow specs drive the *live* Assistants, and the second one restarts the stack
        // underneath the first. Playwright has no per-project worker limit, so each one is its
        // own project and the chain of `dependencies` is what serialises them — against each
        // other and against everything in `base`.
        {
            name: "flow-invoice",
            use: { ...devices["Desktop Chrome"], channel: "chromium" },
            testDir: "./tests/flow",
            testMatch: /1-invoice-slice\.spec\.ts/,
            timeout: 600_000,
            dependencies: ["base"]
        },
        {
            name: "flow-restart",
            use: { ...devices["Desktop Chrome"], channel: "chromium" },
            testDir: "./tests/flow",
            testMatch: /2-restart\.spec\.ts/,
            timeout: 900_000,
            dependencies: ["flow-invoice"]
        },

        // The soak tier, and it is its own project for the same reason the flow specs are: it makes a
        // dozen Things and unmakes them, one after another, and running that beside seven other
        // workers starves the application rather than testing it. Measured — it took an unrelated
        // spec down with it, on `gotoHome()` timing out at ten seconds because the header never
        // rendered. Chained last, so it soaks a stack the rest of the suite has finished with.
        {
            name: "soak",
            use: { ...devices["Desktop Chrome"], channel: "chromium" },
            testDir: "./tests/soak",
            timeout: 900_000,
            // After `base`, not after the flow tier. Chaining it behind `flow-restart` meant it never
            // ran at all here: the flow specs drive the live Assistants, and an Assistant cannot act
            // when the configured model emits its tool calls as prose. A soak test that silently does
            // not run is worse than one that fails.
            dependencies: ["base"]
        },

        { name: "setup-auth", testMatch: /auth\.setup\.ts/, teardown: "cleanup" },
        { name: "cleanup", testMatch: /auth\.teardown\.ts/ }
    ]
});
