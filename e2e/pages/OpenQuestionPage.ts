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
import { AppTestID, TestID } from "../types/testIds";
import type { RaisedQuestion } from "../utils/agents";

import { FormPage } from "./FormPage";
import { OverviewPage } from "./OverviewPage";

export class OpenQuestionPage extends FormPage {
    private readonly overview: OverviewPage;

    constructor(protected override readonly page: Page) {
        super(page);
        this.overview = new OverviewPage(page);
    }

    /**
     * Open one particular question, the way the User now reaches it: through its Conversation.
     *
     * *Open Questions* is no longer a menu entry, so the route is Conversations → the row that is
     * waiting → **Answer** on the Pending Question Bubble. Deep links are off in this application
     * (`deepLinking.onlyWelcomePage`), so the row still has to be found in a table.
     *
     * **The row is addressed by the question's own ThingID**, because `Conversation.currentQuestionId`
     * is an indexed field on the document this overview lists — so the overview's full-text search
     * becomes a server-side `simple_search` that hits it, exactly as the old route's search hit
     * `OpenQuestion.conversationId`. It identifies **one** row by construction: a question is the
     * current question of at most one Conversation.
     *
     * Two routes that look plausible and are not. The Conversation's *own* ThingID is unfindable —
     * it is the docRef, not data, and no field or column carries it. *(subject, assistant)* is
     * unfindable too, and that one is worth spelling out because it is what this change's
     * architecture note proposed: a called Assistant's Conversation inherits its caller's subject
     * only if the calling model passes `subjectThingId` to `assistant.call`, and the scripted model
     * does not — so the accountant's Conversation, which is the one that raises both of the invoice
     * slice's questions, has an empty `subjectThingId`.
     *
     * **No prompt disambiguation any more.** It existed because the old overview listed an answered
     * question beside an unanswered one for the same Conversation. A Conversation has one
     * `currentQuestionId`, so the pending question is unique inside it and there is nothing to tell
     * apart.
     */
    async openQuestion(question: RaisedQuestion) {
        await this.gotoHome();
        await this.clickMenuItem("Conversations");

        await this.overview.search(question.thingId);

        const rows = this.page.getByTestId(TestID.TABLE_BODY_ROW);
        await expect(rows, `one Conversation whose current question is ${question.thingId}`).toHaveCount(1);
        await rows.first().click();
        await this.finishedLoading();

        // The Conversation form, with the thread that leads up to the question.
        const transcript = this.page.getByTestId(AppTestID.CONVERSATION_TRANSCRIPT);
        await expect(transcript).toBeVisible();
        await expect(transcript.getByTestId(AppTestID.TRANSCRIPT_WHO)).toContainText(question.assistantKey);

        await transcript.getByTestId(AppTestID.PENDING_QUESTION_ANSWER).click();
        await this.finishedLoading();

        await this.toBeVisible();
        // The right screen, not merely a form: the Answer Surface carries its Conversation's own
        // header, read across documents by `ConversationId`. The `Conversation` Control that used
        // to be asserted here is now inside the collapsed *Details* section, and a collapsed A12
        // `Section` does not render its children at all — so there is nothing in the DOM to read.
        await expect(this.page.getByTestId(AppTestID.TRANSCRIPT_WHO)).toContainText(question.assistantKey);
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
