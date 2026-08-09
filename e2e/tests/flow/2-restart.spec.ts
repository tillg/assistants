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
 * ADR-0004, executed: **waiting is never a running process.**
 *
 * A Conversation that is waiting on the User holds nothing — no thread, no timer, no in-memory
 * continuation. It is a row with `status = waiting`, `waitingFor = user` and a `currentQuestionId`,
 * and an Open Question with no `answeredAt`. If that is true, then killing and restarting both
 * the Runtime *and* the ThingStore in the middle of a wait must change nothing at all, and the
 * answer given afterwards must carry on from exactly where the Conversation stopped.
 *
 * That is the only assertion here worth making, and the only way to make it is to actually
 * restart the containers — so this test drives `docker compose restart` itself, and therefore
 * runs serially and alone.
 */

import { expect, test } from "../../fixtures";
import type { Browser, Page } from "@playwright/test";
import { OpenQuestionPage } from "../../pages/OpenQuestionPage";
import {
    createArrivingDocument,
    questionIsPending,
    waitForConversationToContinue,
    waitForRaisedQuestion
} from "../../utils/agents";
import { AGENT_TIMEOUT_MS } from "../../utils/config";
import { restartServices, waitForStack } from "../../utils/stack";
import { ThingStore, waitFor } from "../../utils/thingstore";
import { BASE_URL } from "../../utils/config";
import users from "../../fixtures/users.json" with { type: "json" };

/**
 * A page authenticated *after* the restart.
 *
 * The `getPageAs` fixture caches each user's session data for the whole worker and replays it
 * into `sessionStorage`. That token was minted by the server we just restarted, so replaying it
 * lands on the login screen and every locator times out. Logging in again is not a workaround —
 * it is what a human would do, and ADR-0004's claim is about the Open Question surviving in the
 * store, not about a browser session surviving a server restart.
 */
async function loginFreshly(browser: Browser, username: string, password: string): Promise<Page> {
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
    await page.goto(BASE_URL);
    await page.getByRole("textbox", { name: "Username" }).fill(username);
    await page.getByRole("textbox", { name: "Password" }).fill(password);
    await page.getByRole("button", { name: "Login" }).click();
    await expect(page.getByRole("link", { name: "Open Questions" })).toBeVisible({ timeout: 60_000 });
    return page;
}

test.describe.serial("Surviving a restart", () => {
    test("should keep an Open Question, and continue it, across a restart of the Runtime and the store", async ({
        getPageAs,
        browser
    }) => {
        // A document restart takes as long as the stack takes to come up, twice over.
        test.setTimeout(AGENT_TIMEOUT_MS * 4);

        let store = await ThingStore.connect("admin");
        const runId = `restart-${Date.now()}`;

        // --- a Document arrives and a question is raised ---------------------------------------
        const document = await createArrivingDocument(store, runId);
        const question = await waitForRaisedQuestion(store, document.thingId);
        expect(await questionIsPending(store, question)).toBe(true);

        // --- pull the plug ---------------------------------------------------------------------
        // Both halves: the Runtime, which was doing the waiting, and the server, which is the only
        // place the wait was ever recorded.
        restartServices(["runtime", "server"]);
        await waitForStack();
        // The store answers /actuator/health before it will answer RPC; log in again afterwards.
        await waitFor(
            "the ThingStore to serve queries again",
            async () => {
                store = await ThingStore.connect("admin");
                await store.query("RuntimeState_DM", undefined, 1);
                return true;
            },
            180_000,
            3_000
        );

        // --- nothing was lost ------------------------------------------------------------------
        const survived = await store.body(question.docRef, "OpenQuestion");
        expect(String(survived["Prompt"] ?? "")).toBe(question.prompt);
        expect(survived["AnsweredAt"]).toBeFalsy();
        expect(await questionIsPending(store, question)).toBe(true);

        // and it is still in the view a human would look at
        const admin = users.admin;
        const page = await loginFreshly(browser, admin.username, admin.password);
        const openQuestion = new OpenQuestionPage(page);
        await openQuestion.openQuestion(question);

        // --- and answering it still moves the Conversation on ------------------------------------
        await openQuestion.answer({
            confirmed: true,
            text: `Answered after a restart (${runId}).`
        });

        const status = await waitForConversationToContinue(store, question.conversationThingId);
        expect(["running", "waiting", "done"]).toContain(status);

        const answered = await store.body(question.docRef, "OpenQuestion");
        expect(String(answered["AnsweredAt"] ?? "")).not.toBe("");
    });
});
