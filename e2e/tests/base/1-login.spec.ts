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

import { expect, test } from "../../fixtures";
import { USERNAMES } from "../../types";
import { TestID } from "../../types/testIds";

test.describe("Login flow", () => {
    for (const username of USERNAMES) {
        test(`should login with the ${username} user and render the app frame`, async ({ getPageAs }) => {
            const page = await getPageAs(username);
            await page.goto("/");

            // The app frame: header, the identity it was reached with, and a navigable menu.
            const header = page.getByTestId(TestID.APPLICATION_HEADER);
            await expect(header).toBeVisible();

            const popupTrigger = header.getByTestId(TestID.POPUP_TRIGGER_ELEMENT).filter({ hasText: username }).first();
            await expect(popupTrigger).toBeVisible();

            await expect(page.getByTestId(TestID.MENU_ITEM).first()).toBeVisible();
            await expect(page.getByTestId(TestID.CONTENTBOX_TITLE).first()).toBeVisible();

            await popupTrigger.click();
            await expect(page.getByTestId(TestID.POPUP_MENU)).toContainText("Logged in as");
            await expect(page.getByTestId(TestID.POPUP_MENU)).toContainText(username);
        });
    }
});
