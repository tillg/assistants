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
import type { TestData } from "../types";

import { FormPage } from "./FormPage";

export class ComposeFormPage extends FormPage {
    protected readonly relationForm: Locator;

    constructor(
        protected override readonly page: Page,
        protected override readonly formLocator: Locator = page.getByRole("form").first(),
        protected readonly relationFormLocator: Locator = page.getByRole("form").nth(1)
    ) {
        super(page, formLocator);
        this.relationForm = relationFormLocator;
    }

    override async createDocument(data: TestData[], relationData: TestData[] = []): Promise<void> {
        for (const field of data) {
            await this.inputFieldValue(field);
        }

        if (relationData.length === 0) {
            await this.saveForm();
            return;
        }

        await this.form.getByRole("button").filter({ hasText: "Add" }).last().click();
        await expect(this.page.getByRole("form")).toHaveCount(2);
        const relationForm = new FormPage(this.page, this.relationForm);

        for (const field of relationData) {
            await relationForm.inputFieldValue(field);
        }

        await relationForm.saveForm();
        await this.saveForm();
    }
}
