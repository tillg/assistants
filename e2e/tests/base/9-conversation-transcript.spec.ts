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
 * A Conversation looks like a conversation, and a question is shown inside it.
 *
 * One arriving Document gives this spec both of the rows it needs, which is why it starts one
 * rather than hunting for a suitable Conversation in whatever the store happens to hold:
 *
 *   - the **receptionist's** Conversation has a subject — the Document that triggered it — and is
 *     waiting on another Assistant, so it is the *unblocked, has an `about` link* case;
 *   - the **accountant's** Conversation is the one that raises the question, so it is the
 *     *blocked, has a Pending Question Bubble* case. It has no subject at all, because
 *     `assistant.call` passes one only when the calling model says so and the scripted one does not.
 *
 * The Conversation this leaves waiting on the User is left that way deliberately, exactly as
 * `8-operations-catalogue.spec.ts` does: answering it would walk the whole invoice slice a second
 * time and book a second transaction. Conversations and Open Questions are Runtime-owned and never
 * deleted by this suite (`0-clean.setup.ts`); the Document that started it carries the `E2E` prefix,
 * so the next run's clean-up takes it.
 *
 * This is also where the Open Question form's *"opens without a post-processing error"* coverage
 * lives now, because `7-forms-open.spec.ts` navigates by menu and there is no longer a menu entry
 * that reaches that form.
 */

import { expect, test, type Page } from "../../fixtures";
import { OpenQuestionPage } from "../../pages/OpenQuestionPage";
import { OverviewPage } from "../../pages/OverviewPage";
import { AppTestID, TestID } from "../../types/testIds";
import { createArrivingDocument, RECEPTIONIST, waitForRaisedQuestion, type RaisedQuestion } from "../../utils/agents";
import { AGENT_TIMEOUT_MS } from "../../utils/config";
import { ThingStore } from "../../utils/thingstore";

const MODULE = "Conversations";

/** The marker `Conversation_OM`'s expression column renders when `WaitingFor == "user"`. */
const BLOCKED = "🛑";

let store: ThingStore;
let arrived: { docRef: string; thingId: string; title: string };
let question: RaisedQuestion;

test.beforeAll(async () => {
    // A Document birth, a hand-off to a second Assistant and a two-second scan interval.
    test.setTimeout(AGENT_TIMEOUT_MS * 2);

    store = await ThingStore.connect("admin");
    arrived = await createArrivingDocument(store, `transcript-${Date.now()}`);
    question = await waitForRaisedQuestion(store, arrived.thingId);
});

/**
 * Open the blocked Conversation — the accountant's — and return its transcript.
 *
 * Addressed by the question's ThingID: `Conversation.currentQuestionId` is indexed, so the
 * overview's full-text search becomes a server-side `simple_search` that finds exactly the one
 * Conversation waiting on that question.
 */
async function openBlockedConversation(page: Page) {
    const overview = new OverviewPage(page);
    await overview.gotoHome();
    await overview.clickMenuItem(MODULE);
    await overview.search(question.thingId);

    const rows = page.getByTestId(TestID.TABLE_BODY_ROW);
    await expect(rows, `one Conversation whose current question is ${question.thingId}`).toHaveCount(1);
    await rows.first().click();
    await overview.finishedLoading();

    const transcript = page.getByTestId(AppTestID.CONVERSATION_TRANSCRIPT);
    await expect(transcript).toBeVisible();
    return transcript;
}

/** Open the receptionist's Conversation — the one with a subject, and no 🛑. */
async function openSubjectConversation(page: Page) {
    const overview = new OverviewPage(page);
    await overview.gotoHome();
    await overview.clickMenuItem(MODULE);
    await overview.search(arrived.thingId);

    const rows = page.getByTestId(TestID.TABLE_BODY_ROW).filter({ hasText: RECEPTIONIST });
    await expect(rows, `the receptionist's Conversation about Document ${arrived.thingId}`).toHaveCount(1);
    return rows.first();
}

test.describe("Conversation transcript", () => {
    test("should mark a blocked Conversation in the overview, and leave an unblocked one unmarked", async ({
        getPageAs
    }) => {
        const page = await getPageAs("admin");
        const overview = new OverviewPage(page);

        await overview.gotoHome();
        await overview.clickMenuItem(MODULE);
        await expect(page.getByRole("columnheader", { name: "Blocked" })).toBeVisible();

        // The accountant's Conversation is waiting on the User, so it carries the marker.
        await overview.search(question.thingId);
        const blocked = page.getByTestId(TestID.TABLE_BODY_ROW);
        await expect(blocked, `one Conversation whose current question is ${question.thingId}`).toHaveCount(1);
        await expect(blocked.first()).toContainText(BLOCKED);

        // The receptionist's is waiting on another Assistant, so it does not.
        await expect(await openSubjectConversation(page)).not.toContainText(BLOCKED);
    });

    test("should render the entries as a thread rather than as a grid", async ({ getPageAs }) => {
        const page = await getPageAs("admin");
        const transcript = await openBlockedConversation(page);

        // Bubbles, and separators between the clusters they fall into.
        await expect(transcript.getByTestId(AppTestID.TRANSCRIPT_BUBBLE).first()).toBeVisible();
        await expect(transcript.getByTestId(AppTestID.TRANSCRIPT_SEPARATOR).first()).toBeVisible();

        // And no data grid. The `InlineRepeat` over `Entries` is gone, which is the whole point;
        // the form has no other repeat, so any row at all here would be that one coming back.
        await expect(page.getByRole("form").getByTestId(TestID.TABLE_BODY_ROW)).toHaveCount(0);

        // A tool call reads as a receipt: collapsed, and openable to what was sent and returned.
        const receipt = transcript.getByTestId(AppTestID.TRANSCRIPT_RECEIPT).first();
        await expect(receipt).toBeVisible();
        await expect(receipt.getByTestId(AppTestID.TRANSCRIPT_RECEIPT_BODY)).toHaveCount(0);
        await receipt.getByTestId(AppTestID.TRANSCRIPT_RECEIPT_TOGGLE).click();
        await expect(receipt.getByTestId(AppTestID.TRANSCRIPT_RECEIPT_BODY)).toBeVisible();
    });

    test("should keep the header pinned while the thread scrolls", async ({ getPageAs }) => {
        const page = await getPageAs("admin");
        const transcript = await openBlockedConversation(page);

        const header = transcript.getByTestId(AppTestID.TRANSCRIPT_HEADER);
        await expect(header).toBeVisible();
        await expect(header.getByTestId(AppTestID.TRANSCRIPT_WHO)).toContainText(question.assistantKey);
        await expect(header.getByTestId(AppTestID.TRANSCRIPT_BLOCKED)).toBeVisible();
        // A lower bound, never a total: a Turn that threw before writing an Entry recorded nothing.
        await expect(header.getByTestId(AppTestID.TRANSCRIPT_COST)).toContainText("≥");

        // *Why* it stays put, asserted rather than inferred: `position: sticky` fails silently when
        // its scroll ancestor is the wrong one, and here the ancestor has to be the element's own
        // bounded box rather than the form engine's scroll container.
        expect(await transcript.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
        expect(await header.evaluate((element) => getComputedStyle(element).position)).toBe("sticky");

        // And that it does stay put. Scrolling to the last Entry must not take the header with it.
        await transcript.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
        });
        await expect(transcript.getByTestId(AppTestID.TRANSCRIPT_BUBBLE).last()).toBeInViewport();
        await expect(header).toBeInViewport();
    });

    test("should show the pending question's words on the Conversation form", async ({ getPageAs }) => {
        const page = await getPageAs("admin");
        const transcript = await openBlockedConversation(page);

        // This is the case the whole change exists for. The question is read across documents, so
        // its words are on this screen even when the Entry that raised it carries none of them.
        const pending = transcript.getByTestId(AppTestID.PENDING_QUESTION);
        await expect(pending).toBeVisible();
        await expect(pending).toContainText(/[A-Za-z]{4,}/);
        await expect(pending.getByTestId(AppTestID.PENDING_QUESTION_ANSWER)).toBeVisible();
    });

    test("should open the Answer Surface from the Pending Question Bubble", async ({ getPageAs }) => {
        const page = await getPageAs("admin");
        const errors: string[] = [];
        page.on("console", (message) => {
            if (message.type() === "error") {
                errors.push(message.text());
            }
        });

        const openQuestion = new OpenQuestionPage(page);
        await openQuestion.openQuestion(question);

        // The Answer Surface carries the same thread, and the answer controls beneath it.
        await expect(page.getByTestId(AppTestID.CONVERSATION_TRANSCRIPT)).toBeVisible();
        await expect(openQuestion.markdownEditor("Question")).toBeVisible();

        // `7-forms-open.spec.ts` can no longer reach this form, so its guard lives here.
        expect(
            errors.filter((error) => error.includes("Post processing")),
            "the Open Question form failed to load"
        ).toHaveLength(0);
        // The leak alarm: the source module's activities have to be torn down before the push, or
        // a screen of the module we left is still sitting in the activity map.
        expect(
            errors.filter((error) => error.includes("Active screens of module")),
            "an activity was left behind by the jump across modules"
        ).toHaveLength(0);
    });

    test("should follow the header's about link to the subject Thing", async ({ getPageAs }) => {
        const page = await getPageAs("admin");
        const overview = new OverviewPage(page);

        await (await openSubjectConversation(page)).click();
        await overview.finishedLoading();

        const link = page.getByTestId(AppTestID.TRANSCRIPT_ABOUT_LINK);
        await expect(link).toBeVisible();
        await link.click();
        await overview.finishedLoading();

        // The Document's own form, with the Documents list beside it — reading a Thing is a
        // different act, not a step inside a conversation, so its own module is the master.
        const form = page.getByRole("form").first();
        await expect(form).toBeVisible({ timeout: 15_000 });
        await expect(form).toContainText(arrived.title);
    });
});
