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
 * Answering an Open Question — the User's half of the loop.
 *
 * The Runtime writes the question once, at the moment it suspends, and never touches it again;
 * the User completes it in the ordinary instance form. Two writers, never concurrent — which is
 * why there is no separate Answer model and why this page object only ever *fills in* fields.
 *
 * `answeredAt` is filled in deliberately rather than stamped for the User: the watcher's second
 * scan is "an OpenQuestion with `answeredAt` set", so setting it is what hands the turn back.
 */

import { expect, type Page } from "../fixtures";
import { DataType } from "../types";
import { TestID } from "../types/testIds";
import type { RaisedQuestion } from "../utils/agents";
import { getByLabelWithOptionalAsterisk } from "../utils/locators";
import { nowIso, sleep } from "../utils/thingstore";

import { FormPage } from "./FormPage";
import { OverviewPage } from "./OverviewPage";

export class OpenQuestionPage extends FormPage {
    private readonly overview: OverviewPage;

    constructor(protected override readonly page: Page) {
        super(page);
        this.overview = new OverviewPage(page);
    }

    /**
     * Open one particular question in the Open Questions overview.
     *
     * Deep links are off in this application (`deepLinking.onlyWelcomePage`), so a specific row
     * has to be found in the table. `conversationId` is an indexed String and unique per run, so
     * the full-text search narrows to it; the fallback matches the second the question was
     * created in, which is what the overview renders in its first column.
     */
    async openQuestion(question: RaisedQuestion) {
        await this.gotoHome();
        await this.clickMenuItem("Open Questions");

        await this.overview.search(question.conversationThingId);
        await sleep(1_000);

        const rows = this.page.getByTestId(TestID.TABLE_BODY_ROW);
        if ((await rows.count()) === 1) {
            await rows.first().click();
            await this.finishedLoading();
        } else {
            await this.overview.search("");
            await expect(this.overview.getRow(question.createdAt)).toHaveCount(1);
            await this.overview.openDocument(question.createdAt);
        }

        await this.toBeVisible();
        // The right row, not merely a row: the form's Conversation is the one that is waiting.
        await expect(getByLabelWithOptionalAsterisk(this.form, "Conversation", DataType.String)).toHaveValue(
            question.conversationThingId
        );
    }

    /** Answer it: confirm or refuse, say something, and stamp it as answered. */
    async answer(input: { confirmed: boolean; text: string }) {
        await this.startEditing();

        // A `BooleanType` renders as a three-state select — empty / yes / no — not a checkbox.
        await this.inputFieldValue({
            label: "Confirmed",
            value: String(input.confirmed),
            type: DataType.Select
        });
        await this.typeMarkdown("Answer", input.text);
        await this.setAnsweredAt(nowIso());

        await this.saveEdits();
    }

    /**
     * The date-time control parses on blur against the model's own format
     * (`yyyy-MM-dd'T'HH:mm:ss`), so the value surviving the blur is the proof that it parsed.
     */
    private async setAnsweredAt(value: string) {
        const input = getByLabelWithOptionalAsterisk(this.form, "Answered at", DataType.String);
        await input.fill(value);
        await input.press("Tab");
        await expect(input).toHaveValue(value);
    }
}
