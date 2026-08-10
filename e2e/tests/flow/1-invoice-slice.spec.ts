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
 * The slice the whole system exists for.
 *
 * A Document arrives. Nobody presses anything. The Receptionist notices it, works out that it is
 * an invoice, records an Invoice and hands it to the Accountant; the Accountant looks at the
 * chart of accounts and asks the User to approve the booking. The User answers in the ordinary
 * UI. The Accountant books it, and a real transaction appears in real books.
 *
 * Three seams are asserted, each in the only place that can honestly answer:
 *
 *   - the Document goes in through the **ThingStore API**, because that is how the world drops
 *     something on the doormat — no human clicks it into being;
 *   - the question is answered through the **UI**, because "awaiting the User" is a row in a
 *     view, not a callback;
 *   - the booking is checked against **Firefly**, because ADR-0006 makes it the only Authority
 *     for what is owed, and nothing else holds a copy to check against.
 *
 * The `scripted` LLM provider makes all of that deterministic — it is a recorded substitute for
 * a paid, non-deterministic third party, not a mock of anything we own.
 */

import { expect, test } from "../../fixtures";
import { OpenQuestionPage } from "../../pages/OpenQuestionPage";
import {
    ACCOUNTANT,
    createArrivingDocument,
    INVOICE_AMOUNT,
    INVOICE_CURRENCY,
    waitForBirth,
    waitForConversationsDone,
    waitForRaisedQuestion
} from "../../utils/agents";
import { AGENT_TIMEOUT_MS } from "../../utils/config";
import { countTransactions } from "../../utils/firefly";
import { eq, ThingStore, waitFor } from "../../utils/thingstore";

test.describe.serial("Invoice slice", () => {
    test("should turn an arriving Document into an Open Question, an answer and a booking", async ({ getPageAs }) => {
        // Six turns across two Assistants, a two-second scan interval, and a human in the middle.
        test.setTimeout(AGENT_TIMEOUT_MS * 3);

        const store = await ThingStore.connect("admin");
        const runId = String(Date.now());
        const bookedBefore = await countTransactions(INVOICE_AMOUNT, INVOICE_CURRENCY);

        // --- something arrives ----------------------------------------------------------------
        const document = await createArrivingDocument(store, runId);

        // --- the Receptionist notices it, and an Invoice appears -------------------------------
        const born = await waitForBirth(store, document.thingId);
        const invoice = await waitFor(
            `an Invoice extracted from ${document.title}`,
            async () => {
                const [found] = await store.query("Invoice_DM", eq("/Invoice/CreatedByConversationId", born.thingId));
                return found;
            },
            AGENT_TIMEOUT_MS,
            2_000
        );
        const extracted = invoice.document["Invoice"] as Record<string, unknown>;
        expect(String(extracted["InvoiceNumber"])).toBe("2026-118");
        expect(Number(extracted["AmountGross"])).toBe(Number(INVOICE_AMOUNT));

        // --- the Accountant asks the User -----------------------------------------------------
        const question = await waitForRaisedQuestion(store, document.thingId);
        expect(question.assistantKey).toBe(ACCOUNTANT);
        expect(question.prompt).toContain("96.50");

        // --- the User answers, in the UI ------------------------------------------------------
        const page = await getPageAs("admin");
        const openQuestion = new OpenQuestionPage(page);

        await openQuestion.openQuestion(question);
        await expect(openQuestion.markdownEditor("Question")).toContainText("Book this invoice?");
        await openQuestion.answer({
            confirmed: true,
            text: "Yes, please book it against Expenses:Health. Nothing is paid yet."
        });

        // The answer is on the Thing the Runtime will read — and `AnsweredAt` is **empty**, because
        // nothing on the form marks it as required, it has no default, and the page object no longer
        // fills it in on the User's behalf. This assertion used to demand the opposite, which is how
        // BUG-01 shipped: the suite answered in a way no User can, so the product's single most
        // important interaction could fail silently with a green suite. The Conversation continuing
        // past this point is now the proof that a timestamp-less answer is an answer.
        const answered = await store.body(question.docRef, "OpenQuestion");
        expect(answered["Confirmed"]).toBeTruthy();
        expect(String(answered["Text"] ?? "")).toContain("book it");
        expect(String(answered["AnsweredAt"] ?? "")).toBe("");

        // --- the Accountant books it ----------------------------------------------------------
        await waitForConversationsDone(store, document.thingId, AGENT_TIMEOUT_MS);

        // --- and the books say so -------------------------------------------------------------
        await waitFor(
            `one more ${INVOICE_AMOUNT} ${INVOICE_CURRENCY} transaction in Firefly than the ${bookedBefore} there were`,
            async () => (await countTransactions(INVOICE_AMOUNT, INVOICE_CURRENCY)) > bookedBefore || undefined,
            60_000,
            2_000
        );
    });
});
