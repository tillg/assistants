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
 * Answering an Open Question — the User's half of the loop.
 *
 * The Runtime writes the question once, at the moment it suspends, and never touches it again;
 * the User completes it in the ordinary instance form. Two writers, never concurrent — which is
 * why there is no separate Answer model and why this page object only ever *fills in* fields.
 *
 * `answeredAt` is deliberately **not** filled in. The watcher treats any filled answer field as
 * answered (`isAnswered`, `runtime/src/watcher/watcher.ts`), because a User who types an answer and
 * presses Save has answered — nothing on the form marks the timestamp as required, it has no default,
 * and no text anywhere says it matters. This page object therefore does what a User does, and
 * leaving the timestamp empty is what makes these specs the guard for that.
 */

import { expect, type Page } from "../fixtures";
import { DataType } from "../types";
import { TestID } from "../types/testIds";
import type { RaisedQuestion } from "../utils/agents";
import { getByLabelWithOptionalAsterisk } from "../utils/locators";

import { FormPage } from "./FormPage";
import { OverviewPage } from "./OverviewPage";

/**
 * Enough of a prompt to tell two of this Conversation's questions apart, and not more.
 *
 * The overview truncates the prompt column, so matching the whole thing would match nothing. The
 * first line is where both writers put the heading — *"**Book this invoice?**"*, *"**Approval
 * needed.**"* — and markdown asterisks are dropped because the cell renders text, not markdown.
 */
function distinguishingText(prompt: string): string {
    const firstLine = prompt.split("\n").find((line) => line.trim() !== "") ?? prompt;
    return firstLine.replaceAll("*", "").trim().slice(0, 40);
}

export class OpenQuestionPage extends FormPage {
    private readonly overview: OverviewPage;

    constructor(protected override readonly page: Page) {
        super(page);
        this.overview = new OverviewPage(page);
    }

    /**
     * Open one particular question in the Open Questions overview.
     *
     * Deep links are off in this application (`deepLinking.onlyWelcomePage`), so the row has to be
     * found in the table — and every run's question carries the same prompt, so the only thing
     * that tells them apart is the Conversation that raised it. `conversationId` is an indexed
     * String, and the overview's search becomes a server-side `simple_search` over exactly those.
     *
     * **One Conversation can now own more than one row.** A booking raises two questions — the one
     * the Assistant chose to ask and the approval the Runtime demands (ADR-0018) — and the answered
     * one does not leave this view, because the overview's "pending" query model keys on `AnsweredAt`
     * while the Runtime's `isAnswered` counts any filled answer field, and a User (and this suite)
     * leaves the timestamp empty. So the conversation narrows the search and the **prompt** picks the
     * row, using the first line of the question the Runtime or the Assistant actually wrote.
     */
    async openQuestion(question: RaisedQuestion) {
        await this.gotoHome();
        await this.clickMenuItem("Open Questions");

        await this.overview.search(question.conversationThingId);

        const all = this.page.getByTestId(TestID.TABLE_BODY_ROW);
        await expect(all, `searching for conversation ${question.conversationThingId}`).not.toHaveCount(0);
        const rows = all.filter({ hasText: distinguishingText(question.prompt) });
        await expect(
            rows,
            `one row for conversation ${question.conversationThingId} whose prompt starts "${distinguishingText(question.prompt)}"`
        ).toHaveCount(1);
        await rows.first().click();
        await this.finishedLoading();

        await this.toBeVisible();
        // The right row, not merely a row: the form's Conversation is the one that is waiting.
        await expect(getByLabelWithOptionalAsterisk(this.form, "Conversation", DataType.String)).toHaveValue(
            question.conversationThingId
        );
    }

    /** Answer it exactly as a User does: confirm or refuse, say something, save. No timestamp. */
    async answer(input: { confirmed: boolean; text: string }) {
        await this.startEditing();

        // A `BooleanType` renders as a three-state select — empty / yes / no — not a checkbox.
        await this.inputFieldValue({
            label: "Confirmed",
            value: String(input.confirmed),
            type: DataType.Select
        });
        await this.typeMarkdown("Answer", input.text);

        await this.saveEdits();
    }
}
