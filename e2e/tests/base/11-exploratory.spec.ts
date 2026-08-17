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
 * The exploratory pass: a lot of data, made and unmade through the application, with the Dashboard
 * asked to keep up.
 *
 * `3-crud.spec.ts` proves one Party can be created, read, updated and deleted. This asks a different
 * question — **does the story still hold at volume, and does the Dashboard tell the truth while it is
 * happening?** The counting Tiles read the same store these Parties are being written to, and the
 * money Tiles read Firefly through the Runtime, so a run that creates twenty Things and then checks
 * the Dashboard exercises both seams against a store that is genuinely moving underneath them.
 *
 * Deliberately *not* asserted here: that a count rises by exactly the number created. The Runtime is
 * scanning every two seconds and creating Conversations of its own throughout, so an exact figure
 * would be a race dressed up as an assertion. What is asserted is monotonic and structural — the
 * count does not go *down*, the Tiles do not fall into `error`, and every row that was written can be
 * found again by searching for it.
 */

import { expect, test } from "../../fixtures";
import { DashboardPage } from "../../pages/DashboardPage";
import { FormPage } from "../../pages/FormPage";
import { OverviewPage } from "../../pages/OverviewPage";
import { DataType, type TestData } from "../../types";
import { E2E_PREFIX } from "../../utils/config";

/** Enough to be a volume test, few enough that a failure is still readable. */
const HOW_MANY = 12;

const stamp = Date.now();
const partyName = (index: number) => `${E2E_PREFIX} Exploratory ${stamp} #${String(index).padStart(2, "0")}`;

const identity = (index: number): TestData[] => [
    { label: "Name", value: partyName(index), type: DataType.String },
    { label: "Role", value: index % 2 === 0 ? "doctor" : "insurer", type: DataType.Autocomplete }
];

test.describe("Exploratory: volume, and the Dashboard while it happens", () => {
    test("creates many Parties, finds them all again, and leaves the Dashboard standing", async ({
        getPageAs
    }) => {
        test.setTimeout(600_000);

        const page = await getPageAs("admin");
        const overview = new OverviewPage(page);
        const dashboard = new DashboardPage(page);

        // What the Dashboard said before any of this — the baseline the monotonic assertions use.
        await dashboard.gotoHome();
        await dashboard.waitForTiles();
        const documentsBefore = await dashboard.headlineNumber("documents");
        await expect(dashboard.failedTiles()).toHaveCount(0);

        await overview.clickMenuItem("Parties");

        // --- create, at volume ------------------------------------------------------------------
        for (let index = 0; index < HOW_MANY; index += 1) {
            await overview.addDocument(identity(index));
            // Asserted per row rather than once at the end: a create that silently did nothing is
            // worth catching where it happened, not twelve rows later.
            await expect(overview.getRow(partyName(index))).toBeVisible();
        }

        // --- search: every one of them is findable by its own name ------------------------------
        for (let index = 0; index < HOW_MANY; index += 1) {
            await overview.search(partyName(index));
            await expect(overview.getRow(partyName(index))).toBeVisible();
        }
        await overview.search("");

        // --- the Dashboard, mid-flight ----------------------------------------------------------
        await dashboard.gotoHome();
        await dashboard.waitForTiles();

        // No Tile may have fallen over while the store was being written to underneath it.
        await expect(dashboard.failedTiles()).toHaveCount(0);

        // Monotonic, not exact: the Runtime is creating Conversations throughout, so the only honest
        // claim is that nothing went backwards.
        expect(await dashboard.headlineNumber("documents")).toBeGreaterThanOrEqual(documentsBefore);

        // The money Tiles read Firefly through the Runtime. Nothing in this test touches the books,
        // so their content must be unchanged in shape — rows present, one total per currency.
        await expect(dashboard.rows("accounts", "account").first()).toBeVisible();
        const totals = await dashboard.rows("accounts", "total").allInnerTexts();
        expect(totals.length).toBeGreaterThan(0);

        // --- update -----------------------------------------------------------------------------
        const form = new FormPage(page);
        const city: TestData = { label: "City", value: "Frechen", type: DataType.String };
        await overview.clickMenuItem("Parties");
        await overview.search(partyName(0));
        await overview.openDocument(partyName(0));
        await form.toBeVisible();
        await form.startEditing();
        await form.clearFieldValue(city);
        await form.inputFieldValue(city);
        await form.saveEdits();

        // Persisted rather than merely rendered — come back through a fresh load, as 3-crud does.
        await overview.gotoHome();
        await overview.clickMenuItem("Parties");
        await overview.search(partyName(0));
        await expect(overview.getRow(partyName(0))).toContainText("Frechen");

        // --- delete, all of them ----------------------------------------------------------------
        for (let index = 0; index < HOW_MANY; index += 1) {
            await overview.search(partyName(index));
            await overview.deleteDocument(partyName(index));
        }
        await overview.search("");

        // --- and the Dashboard survives the tear-down too ----------------------------------------
        await dashboard.gotoHome();
        await dashboard.waitForTiles();
        await expect(dashboard.failedTiles()).toHaveCount(0);
    });
});
