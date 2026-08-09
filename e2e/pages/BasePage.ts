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

import type { Locator } from "@playwright/test";

import { expect, type Page } from "../fixtures";
import { TestID } from "../types/testIds";

export class BasePage {
    constructor(protected readonly page: Page) {}

    /**
     * Wait for the progress overlays to go away.
     *
     * The timeout is generous on purpose: right after the stack restarts, the client refetches the
     * whole model graph before the first screen settles, and the default 5 s is not enough. A
     * spinner that is genuinely stuck still fails — just later, and for the right reason.
     */
    async finishedLoading(scope: Locator | Page = this.page, timeout = 60_000) {
        const loadings = await scope.getByTestId(TestID.PROGRESS_INDICATOR_OUTER_OVERLAY).all();
        for (const loading of loadings) {
            await expect(loading).toBeHidden({ timeout });
        }
    }

    async gotoHome() {
        await this.page.goto("/");
        await expect(this.page.getByTestId(TestID.HEADER_TRIGGER_TEXT).first()).toBeVisible();
        await this.finishedLoading();
    }

    async clickMenuItem(label: string) {
        await this.page
            .getByTestId(TestID.MENU_ITEM)
            .filter({ has: this.page.getByText(label, { exact: true }) })
            .click();
        await this.finishedLoading();
    }

    async switchOnEnglish() {
        await this.page.getByTestId(TestID.HEADER_TRIGGER_TEXT).filter({ hasText: "EN" }).click();
        await this.page.getByTestId(TestID.LIST_ITEM_TEXT).filter({ hasText: "English (EN)" }).click();
        const languagePopupTrigger = this.page
            .getByTestId(TestID.POPUP_TRIGGER_ELEMENT)
            .filter({ hasText: "EN" })
            .first();
        await expect(languagePopupTrigger).toBeVisible();
    }
}
