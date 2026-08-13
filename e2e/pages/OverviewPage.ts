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

import { TestID } from "../types/testIds";
import type { TestData } from "../types";
import { type Page, expect } from "../fixtures";
import { API_PATH, waitForApiReponse } from "../utils/api";

import { BasePage } from "./BasePage";
import { FormPage } from "./FormPage";
import { ComposeFormPage } from "./ComposeFormPage";

export class OverviewPage extends BasePage {
    private readonly table: Locator;

    constructor(protected override readonly page: Page) {
        super(page);
        this.table = page.getByTestId(TestID.TABLE);
    }
    async assertDocumentsInTable(documents: string[]) {
        for (const doc of documents) {
            await expect(this.table.getByTestId(TestID.TABLE_BODY_ROW).filter({ hasText: doc })).toBeVisible();
        }
    }

    async assertThumbnailInTable(thumbnailFileName: string, locator: Locator = this.table) {
        await expect(locator.getByRole("img", { name: thumbnailFileName })).toBeVisible();
    }

    async addDocument(document: TestData[], formLocator?: Locator) {
        await this.page.getByRole("button", { name: "Add" }).click();
        const formPage = new FormPage(this.page, formLocator);
        await formPage.finishedLoading();
        await formPage.toBeVisible();
        await formPage.createDocument(document);
        await this.assertDocumentsInTable([document[0]?.value ?? ""]);
    }

    async addComposeDocument(
        document: TestData[],
        relationData: TestData[] = [],
        formLocator?: Locator,
        relationFormLocator?: Locator
    ) {
        await this.page.getByRole("button", { name: "Add" }).click();
        const composeFormPage = new ComposeFormPage(this.page, formLocator, relationFormLocator);
        await composeFormPage.toBeVisible();
        await composeFormPage.createDocument(document, relationData);
        await this.assertDocumentsInTable([document[0]?.value ?? ""]);
    }

    getRow(document: string): Locator {
        const table = this.page.getByTestId(TestID.TABLE);
        const row = table.getByTestId(TestID.TABLE_BODY_ROW).filter({ hasText: document });
        return row;
    }

    /** Open a row's instance form. */
    async openDocument(document: string) {
        const row = this.getRow(document).first();
        await expect(row).toBeVisible();
        await row.click();
        await this.finishedLoading();
        await expect(this.page.getByRole("form").first()).toBeVisible();
    }

    async assertDocumentNotInTable(document: string) {
        await expect(this.getRow(document)).toHaveCount(0);
    }

    /**
     * The overview's full-text search. It becomes a `simple_search` constraint over the Model's
     * indexed fields server-side, which is the only way to find one row among many pages.
     */
    async search(term: string) {
        const input = this.page.locator('input[role="search"], [role="search"] input').first();
        await input.fill(term);
        await input.press("Enter");
        await this.finishedLoading();
    }

    async deleteRow(row: Locator, hasConfirmation: boolean = true) {
        await expect(row).toBeVisible();
        await row.getByRole("button").filter({ hasText: "delete" }).click();
        if (hasConfirmation) {
            await this.page.getByRole("button", { name: "Delete" }).click();
        }
        await waitForApiReponse({
            page: this.page,
            apiPath: API_PATH.RPC,
            expectedStatusCode: 200
        });
        await waitForApiReponse({
            page: this.page,
            apiPath: API_PATH.RPC,
            expectedStatusCode: 200
        });
    }

    async deleteAllRows(hasConfirmation: boolean = true) {
        let rowCount = await this.page.getByTestId(TestID.TABLE_BODY_ROW).count();

        while (rowCount > 0) {
            const firstRow = this.page.getByTestId(TestID.TABLE_BODY_ROW).first();
            await this.deleteRow(firstRow, hasConfirmation);
            await this.finishedLoading();
            rowCount = await this.page.getByTestId(TestID.TABLE_BODY_ROW).count();
        }

        await expect(this.page.getByTestId(TestID.TABLE_BODY_ROW)).toHaveCount(0);
        await expect(this.page.getByTestId(TestID.MESSAGE)).toHaveText("No results found");
    }

    async deleteDocument(document: string, hasConfirmation: boolean = true): Promise<void> {
        const row = this.getRow(document);
        await this.deleteRow(row, hasConfirmation);
    }

    async exportDocumentsToCSV(expectedFileName: string): Promise<void> {
        const downloadedFilePromise = this.page.waitForEvent("download");
        await this.page.getByRole("button", { name: "Export" }).click();
        await this.page.getByRole("button", { name: "OK" }).click();
        await waitForApiReponse({
            page: this.page,
            apiPath: API_PATH.RPC,
            expectedStatusCode: 200
        });
        const downloadFile = await downloadedFilePromise;
        expect(downloadFile.suggestedFilename()).toBe(expectedFileName);
    }
}
