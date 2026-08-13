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

import { expect } from "@playwright/test";

import { test } from "../../fixtures";
import { BasePage } from "../../pages/BasePage";

test.describe("Favicon test", () => {
    test("favicon should display correctly", async ({ getPageAs }) => {
        const page = await getPageAs("admin");
        const app = new BasePage(page);
        await app.gotoHome();
        const favicon = page.locator('link[rel="icon"]');
        await expect(favicon).toHaveAttribute("href", /favicon\.svg(\?.*)?$/);
    });
});
