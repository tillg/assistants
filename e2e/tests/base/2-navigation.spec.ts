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
