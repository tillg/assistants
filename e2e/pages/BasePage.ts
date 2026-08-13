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
