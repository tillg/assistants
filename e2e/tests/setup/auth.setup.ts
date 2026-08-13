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

import { expect, type Page, test } from "@playwright/test";

import { type TestUsername, USERNAMES } from "../../types";
import USERS from "../../fixtures/users.json" with { type: "json" };
import { TestID } from "../../types/testIds";
import { KEYCLOAK_REALM, KEYCLOAK_URL } from "../../utils/config";
import { ensureAuthDirExists, getUserAuthStorageStatePath, writeUserSessionData } from "../../utils/files";

test("Auth setup", async ({ browser }) => {
    await ensureAuthDirExists();

    async function setupAuthForUser(username: TestUsername) {
        const context = await browser.newContext();
        const page = await context.newPage();
        const user = USERS[username];
        // The application has no login form of its own: opening it bounces the browser to
        // Keycloak, and only the redirect back carries a token. Keycloak's own form happens to
        // use the same `#username` / `#password` ids the UAA one did, so the three lines below
        // are unchanged -- but they now run against a different origin, and `fill` is what
        // waits for the redirect to land.
        await page.goto("/");
        const keycloakPrefix = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/`;
        await page.waitForURL((url) => url.href.startsWith(keycloakPrefix), { timeout: 30_000 });
        await page.fill("#username", user.username);
        await page.fill("#password", user.password);
        await page.press("#password", "Enter");

        const popupTrigger = page
            .getByTestId(TestID.APPLICATION_HEADER)
            .getByTestId(TestID.POPUP_TRIGGER_ELEMENT)
            .filter({ hasText: username })
            .first();
        await expect(popupTrigger).toBeVisible({ timeout: 30_000 });

        const sessionData = await extractSessionData(page);
        await writeUserSessionData(username, sessionData);
        // Cookies as well as sessionStorage, and Keycloak's SSO cookie is the important one --
        // see getUserAuthStorageStatePath. Written after the assertion above, so a context is
        // only ever seeded from a session that demonstrably reached the application frame.
        await context.storageState({ path: getUserAuthStorageStatePath(username) });
        await context.close();
    }

    await Promise.all(USERNAMES.map((username) => setupAuthForUser(username)));
});

async function extractSessionData(page: Page): Promise<Record<string, string>> {
    return await page.evaluate(() => {
        const data: Record<string, string> = {};
        for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            if (!key) {
                continue;
            }
            data[key] = sessionStorage.getItem(key) || "";
        }
        return data;
    });
}
