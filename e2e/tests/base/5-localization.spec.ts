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

import { test, expect, type Page } from "../../fixtures";
import { BasePage } from "../../pages/BasePage";
import { TestID } from "../../types/testIds";

test.describe("Test language switching", () => {
    let page: Page;
    test.beforeEach(async ({ getPageAs }) => {
        page = await getPageAs("admin");
        const app = new BasePage(page);
        await app.gotoHome();
    });

    /*
     * These two used to read the ContentBox title off the welcome page, which was the Conversations
     * overview. The welcome page is now the Dashboard, and a Dashboard renders no ContentBox title at
     * all — so the assertion moves to opening a module by its localised menu label, which is a stronger
     * check of the same thing: it proves the menu, the label and the scene all speak the chosen
     * language. This is a behaviour change moving its test with it, not a test bent to pass.
     */
    test("should display in English", async () => {
        await page.getByTestId(TestID.HEADER_TRIGGER_TEXT).filter({ hasText: "EN" }).click();
        await page.getByTestId(TestID.LIST_ITEM_TEXT).filter({ hasText: "English (EN)" }).click();
        const languagePopupTrigger = page.getByTestId(TestID.POPUP_TRIGGER_ELEMENT).filter({ hasText: "EN" }).first();
        await expect(languagePopupTrigger).toBeVisible();

        await new BasePage(page).clickMenuItem("Documents");

        await expect(page.getByTestId(TestID.CONTENTBOX_TITLE)).toHaveText("Documents");
    });

    test("should display in German", async () => {
        await page.getByTestId(TestID.HEADER_TRIGGER_TEXT).filter({ hasText: "EN" }).click();
        await page.getByTestId(TestID.LIST_ITEM_TEXT).filter({ hasText: "German (DE)" }).click();
        const languagePopupTrigger = page.getByTestId(TestID.POPUP_TRIGGER_ELEMENT).filter({ hasText: "DE" }).first();
        await expect(languagePopupTrigger).toBeVisible();

        await new BasePage(page).clickMenuItem("Dokumente");

        await expect(page.getByTestId(TestID.CONTENTBOX_TITLE)).toHaveText("Dokumente");
    });
});
