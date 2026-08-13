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

import { test as base, expect, type Page, type BrowserContext } from "@playwright/test";

import { type SessionStorageData, type TestUsername } from "../types";
import { getUserAuthStorageStatePath, getUserSessionData } from "../utils/files";

type WorkerFixtureOptions = {
    getPageAs: (userName: TestUsername) => Promise<Page>;
};

export const test = base.extend<object, WorkerFixtureOptions>({
    getPageAs: [
        async ({ browser }, use) => {
            const sessionStorageCache: Map<TestUsername, SessionStorageData> = new Map();
            const contexts: BrowserContext[] = [];

            async function getPageAs(username: TestUsername): Promise<Page> {
                let sessionData = sessionStorageCache.get(username);
                if (!sessionData) {
                    sessionData = await getUserSessionData(username);
                    sessionStorageCache.set(username, sessionData);
                }

                // Both halves are needed. The cookies carry Keycloak's SSO session, without which
                // the application's redirect to the identity provider ends on a login form; the
                // sessionStorage carries the OIDC user the client reads the access token from.
                const context = await browser.newContext({
                    storageState: getUserAuthStorageStatePath(username)
                });
                await context.addInitScript(injectSessionStorage, sessionData);
                contexts.push(context);

                const page: Page = await context.newPage();
                return page;
            }
            await use(getPageAs);

            await Promise.allSettled(
                contexts.map(async (context) => {
                    try {
                        await context.close();
                    } catch (error) {
                        console.warn("Failed to close browser context:", error);
                    }
                })
            );
        },
        { scope: "worker" }
    ]
});

function injectSessionStorage(storage: Record<string, string>) {
    for (const [k, v] of Object.entries(storage)) {
        try {
            window.sessionStorage.setItem(k, v);
        } catch {
            console.error(`Failed to set sessionStorage item: ${k}`);
        }
    }
}

export { expect, type Page };
