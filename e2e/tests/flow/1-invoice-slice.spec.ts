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
 *
 * **Two questions, not one, and that is the point of ADR-0018.** The scripted Accountant asks
 * politely before booking, as its prompt tells it to — and that ask no longer counts for anything,
 * because a question the Assistant composed cannot be the thing that constrains the Assistant. So
 * its first `postTransaction` is refused by the Runtime, which raises an approval of its own bound to
 * those exact arguments, and the model calls again identically once the User has said yes.
 *
 * That this test had to change is the demonstration that what it used to prove was the model's good
 * manners rather than the rule.
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
        // Eight turns across two Assistants, a two-second scan interval, and a human in the middle
        // twice — the Assistant's own question, then the Runtime's approval.
        test.setTimeout(AGENT_TIMEOUT_MS * 4);

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

        // --- and nothing is booked yet, because that yes was not an approval -------------------
        //
        // The Assistant chose to ask, and its own question authorises nothing (ADR-0018). The
        // Runtime refuses the posting and asks for itself, bound to those exact arguments.
        const approval = await waitForRaisedQuestion(store, document.thingId, AGENT_TIMEOUT_MS, [question.thingId]);
        expect(approval.thingId).not.toBe(question.thingId);
        expect(approval.assistantKey).toBe(ACCOUNTANT);
        // The Runtime's own wording, and the exact arguments rendered as a sentence — not a JSON blob,
        // which is how a safety feature becomes a thing people click yes on without reading.
        expect(approval.prompt).toContain("Approval needed");
        expect(approval.prompt).toContain(`€${INVOICE_AMOUNT}`);
        expect(approval.prompt).toContain("Payables");
        expect(approval.prompt).toContain("Expenses:Health");
        expect(await countTransactions(INVOICE_AMOUNT, INVOICE_CURRENCY)).toBe(bookedBefore);

        // The refusal is in the transcript rather than inferred from an absence, and it says the
        // booking is not queued — because it is not, and the model has to call again.
        const refused = await store.body(`Conversation_DM/${approval.conversationThingId}`, "Conversation");
        const entries = (refused["Entries"] ?? []) as Array<Record<string, unknown>>;
        const request = entries.find((entry) => entry["Kind"] === "approval-request");
        expect(request, "the transcript records that the Runtime asked").toBeDefined();
        expect(String(request!["ToolName"])).toBe("bookkeeping.postTransaction");
        expect(String(request!["QuestionId"])).toBe(approval.thingId);
        expect(String(request!["ArgsHash"] ?? "")).not.toBe("");
        expect(entries.some((entry) => String(entry["ToolResult"] ?? "").includes("not queued"))).toBe(true);

        // --- the User approves it, in the same ordinary UI ------------------------------------
        await openQuestion.openQuestion(approval);
        await expect(openQuestion.markdownEditor("Question")).toContainText("Approval needed");
        await openQuestion.answer({
            confirmed: true,
            text: "Approved — that is the right posting."
        });

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
