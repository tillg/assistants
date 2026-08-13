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
 * Full CRUD on a Party, through the real UI.
 *
 * Party is the right subject: it is a plain user-owned Thing with no Runtime involvement, so
 * creating and deleting one asserts the A12 stack — models, form, overview, store — and nothing
 * about the Assistants.
 *
 * One test rather than four, because CRUD is one story and the later steps have no meaning
 * without the earlier ones.
 */

import { expect, test } from "../../fixtures";
import { FormPage } from "../../pages/FormPage";
import { OverviewPage } from "../../pages/OverviewPage";
import { DataType, type TestData } from "../../types";
import { E2E_PREFIX } from "../../utils/config";

const NAME = `${E2E_PREFIX} Praxis Dr. Meyer ${Date.now()}`;
const ROLE = "doctor";
const CITY_BEFORE = "Köln";
const CITY_AFTER = "Frechen";

const IDENTITY: TestData[] = [
    { label: "Name", value: NAME, type: DataType.String },
    { label: "Role", value: ROLE, type: DataType.Autocomplete }
];

const cityField = (value: string): TestData => ({ label: "City", value, type: DataType.String });

test.describe("Party CRUD", () => {
    test("should create, read, update and delete a Party", async ({ getPageAs }) => {
        test.setTimeout(120_000);

        const page = await getPageAs("admin");
        const overview = new OverviewPage(page);
        const form = new FormPage(page);

        await overview.gotoHome();
        await overview.clickMenuItem("Parties");

        // --- create -------------------------------------------------------------------------
        await overview.addDocument([...IDENTITY, cityField(CITY_BEFORE)]);
        await expect(overview.getRow(NAME)).toContainText(ROLE);
        await expect(overview.getRow(NAME)).toContainText(CITY_BEFORE);

        // --- read ---------------------------------------------------------------------------
        await overview.openDocument(NAME);
        await form.toBeVisible();
        await form.assertFormValues([...IDENTITY, cityField(CITY_BEFORE)]);

        // --- update -------------------------------------------------------------------------
        await form.startEditing();
        await form.clearFieldValue(cityField(CITY_AFTER));
        await form.inputFieldValue(cityField(CITY_AFTER));
        await form.saveEdits();

        // Persisted, not merely rendered: come back through a fresh page load.
        await overview.gotoHome();
        await overview.clickMenuItem("Parties");
        await expect(overview.getRow(NAME)).toContainText(CITY_AFTER);
        await overview.openDocument(NAME);
        await form.toBeVisible();
        await form.assertFieldValue(cityField(CITY_AFTER));

        // --- delete -------------------------------------------------------------------------
        await overview.gotoHome();
        await overview.clickMenuItem("Parties");
        await overview.deleteDocument(NAME);
        await overview.assertDocumentNotInTable(NAME);

        // And still gone after a reload — the row went from the store, not just from the table.
        await overview.gotoHome();
        await overview.clickMenuItem("Parties");
        await overview.assertDocumentNotInTable(NAME);
    });
});
