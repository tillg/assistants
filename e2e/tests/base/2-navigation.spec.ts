/*
 * SPDX-License-Identifier: EUPL-1.2
 *
 * Copyright (c) 2026 Till Gartner
 *
 * Part of Assistants.
 *
 * Licensed under the European Union Public Licence, version 1.2 - see
 * https://eupl.eu/ and the LICENSE file at the root of this repository.
 * Distributed on an "AS IS" basis, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.
 */

/**
 * Every module in `AssistantsAppModel_AM` is reachable and renders.
 *
 * Each module is checked against a column heading only *its* overview model declares, so the
 * test fails if the menu opens the wrong scene — which a bare "a table appeared" assertion would
 * happily accept.
 */

import { expect, test } from "../../fixtures";
import { BasePage } from "../../pages/BasePage";
import { TestID } from "../../types/testIds";

const MODULES: Array<{ menu: string; column: string }> = [
    { menu: "Open Questions", column: "Question" },
    { menu: "Documents", column: "Classification" },
    { menu: "Invoices", column: "Invoice number" },
    { menu: "Processes", column: "Kind" },
    { menu: "Parties", column: "Role" },
    { menu: "Assistants", column: "LLM model" },
    // Not `Key`: Assistant_OM has one too, and a column that two overviews declare cannot tell
    // the test which scene the menu opened.
    { menu: "Operations", column: "Requires approval" },
    { menu: "Conversations", column: "Waiting for" },
    { menu: "Runtime", column: "Heartbeat at" }
];

test.describe("Navigation", () => {
    for (const { menu, column } of MODULES) {
        test(`should open the ${menu} module from the menu`, async ({ getPageAs }) => {
            const page = await getPageAs("admin");
            const app = new BasePage(page);
            await app.gotoHome();

            await app.clickMenuItem(menu);

            await expect(page.getByTestId(TestID.CONTENTBOX_TITLE).first()).toBeVisible();
            const table = page.getByTestId(TestID.TABLE).first();
            await expect(table).toBeVisible();
            await expect(table.getByText(column, { exact: true }).first()).toBeVisible();

            // Nothing blew up on the way: A12 reports failures as notifications.
            await expect(page.getByTestId(TestID.NOTIFICATION_ITEM_TITLE)).toHaveCount(0);
        });
    }
});
