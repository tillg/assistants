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
 * The invoice slice with its first step deleted: **nobody creates the Document.**
 *
 * `flow/1-invoice-slice.spec.ts` drops a Document on the doormat through the ThingStore API, which
 * is honest about the Assistants and silent about how anything ever arrives. Here the only gesture
 * is the one a User actually makes — an `.eml` lands in a mailbox — and everything after it is the
 * shipping system: a real IMAP server, the real Email Connector on the real fifth scan, the real
 * Content Store, the real Receptionist, and the question waiting in the real web application.
 *
 * What each seam is asserted at, and why it is the only place that can answer:
 *
 *   - the mail goes in over **IMAP APPEND**, because that is what a delivering server does. Nothing
 *     in this spec writes a Thing;
 *   - the Document is read from the **ThingStore**, because `Source: email` and `ExternalRef` are
 *     the two fields this whole change exists to write, and `ExternalRef` is what makes a re-poll
 *     idempotent;
 *   - the message having reached `assistants/processed` is read from the **mailbox**, because
 *     "move last" is the ordering the User's invoice depends on and the mailbox is where it shows;
 *   - the question is opened in the **UI**, because "waiting on the User" is a row in a view.
 *
 * **This spec reconfigures the Runtime container, and that is the point, not a workaround.**
 * `MAIL_HOST` in `.env` is empty — the shipped default — so scan 5 never runs on a stack nobody has
 * given a mailbox. There is no honest way to test a poll of a mailbox that does not exist: faking
 * the ingest would assert this file's own arithmetic, and pointing the tier at a real Gmail account
 * would make it depend on a credential, a network and a third party's rate limiter. So the tier
 * brings its own letterbox (`utils/mailbox.ts`), points the Runtime at it, and puts the Runtime back.
 *
 * **The model is pinned to `scripted` for the same run.** The claim under test is that a Document
 * born from a mail triggers the Receptionist exactly as a typed one does. A locally configured model
 * that emits its tool calls as prose would fail that assertion for a reason that has nothing to do
 * with the letterbox — and `llm.json` is the developer's own gitignored file, so what it says is not
 * something this spec may assume. `scripted` is a recorded substitute for a paid, non-deterministic
 * third party, not a mock of anything this repository owns.
 *
 * Which means the Open Question that arrives is the Accountant's *"Book this invoice?"* rather than
 * the `document.requestText` a live model would ask for a text-free PDF. Either is the same
 * assertion — an Open Question about a mail nobody typed in is waiting in the inbox — and this one
 * is the same question `1-invoice-slice` already knows how to open.
 */

import path from "node:path";

import { expect, test } from "../../fixtures";
import { OpenQuestionPage } from "../../pages/OpenQuestionPage";
import { RECEPTIONIST, waitForBirth, waitForRaisedQuestion } from "../../utils/agents";
import { AGENT_TIMEOUT_MS, REPO_ROOT } from "../../utils/config";
import {
    MAILBOX_CONTAINER,
    MAILBOX_CONTAINER_PORT,
    MAILBOX_FOLDERS,
    MAILBOX_PASSWORD,
    MAILBOX_USER,
    Mailbox,
    stampedFixture
} from "../../utils/mailbox";
import { recreateRuntimeWith, restoreRuntime, waitForRuntimeLog } from "../../utils/stack";
import { eq, ThingStore, thingIdOf, waitFor } from "../../utils/thingstore";

/** A forwarded mail with one PDF — the proposal's own example, and already a parser fixture. */
const FIXTURE = "forward-one-pdf.eml";
/** Whom that fixture is from. The allowlist is default-deny, so this has to be named. */
const SENDER = "user@example.com";

/** Two seconds, not the configured minute: nothing here is waiting on a provider's rate limiter. */
const POLL_INTERVAL_MS = 2_000;

let mailbox: Mailbox;

test.describe.serial("A mail arrives", () => {
    test.beforeAll(async () => {
        test.setTimeout(300_000);

        mailbox = await Mailbox.start();
        await mailbox.createIncomingFolder();

        recreateRuntimeWith(
            {
                MAIL_HOST: MAILBOX_CONTAINER,
                MAIL_PORT: String(MAILBOX_CONTAINER_PORT),
                // Plaintext, and visible here rather than hidden behind a flag that keeps TLS and
                // stops verifying it. GreenMail's IMAPS certificate cannot pass hostname
                // verification by any route, so the choice was this or that — see utils/mailbox.ts.
                MAIL_SECURE: "false",
                MAIL_USER: MAILBOX_USER,
                MAIL_PASSWORD: MAILBOX_PASSWORD,
                MAIL_ALLOWED_SENDERS: SENDER,
                MAIL_POLL_INTERVAL_MS: String(POLL_INTERVAL_MS),
                LLM_CONFIG_FILE: "/app/llm-e2e.json"
            },
            { [path.join(REPO_ROOT, "e2e", "fixtures", "llm-scripted.json")]: "/app/llm-e2e.json" }
        );

        // Not "the container is up": the line the Runtime only prints when it has read this
        // configuration, and it names the sender count, so an empty allowlist — which would reject
        // every message and pass no test — is caught here rather than three minutes later.
        const configured = await waitForRuntimeLog("the letterbox is configured");
        expect(configured, "the Runtime read the letterbox configuration").toContain(MAILBOX_CONTAINER);
        expect(configured, "exactly one sender is allowed").toContain('"allowedSenders":1');
    });

    test.afterAll(async () => {
        test.setTimeout(300_000);
        // Both, in this order, and neither may be skipped because the other threw: the Runtime is
        // shared with every spec that runs after this one, and a stray container holds a port.
        try {
            restoreRuntime();
        } finally {
            mailbox?.stop();
        }
    });

    test("should turn an .eml nobody typed into a Document, and an Open Question waiting in the web application", async ({
        getPageAs
    }) => {
        // A poll, a birth, and three turns across two Assistants.
        test.setTimeout(AGENT_TIMEOUT_MS * 3);

        const store = await ThingStore.connect("admin");
        const runId = String(Date.now());
        // The fixture's Message-ID and Subject are stamped with the run: the first becomes
        // `ExternalRef` and makes a re-poll create nothing, the second becomes `Title` and is how
        // `0-clean.setup.ts` recognises what this tier left behind.
        const mail = stampedFixture(FIXTURE, runId);

        // --- the only gesture: the mail is delivered ------------------------------------------
        await mailbox.deliver(MAILBOX_FOLDERS.incoming, mail.bytes);

        // --- the letterbox is emptied, and a Document exists ----------------------------------
        const document = await waitFor(
            `a Document with ExternalRef ${mail.externalRef}`,
            async () => {
                const [found] = await store.query("Document_DM", eq("/Document/ExternalRef", mail.externalRef));
                return found;
            },
            AGENT_TIMEOUT_MS,
            2_000
        );

        const body = (document.document["Document"] ?? {}) as Record<string, unknown>;
        expect(String(body["Source"]), "the Connector is the writer Source: email never had").toBe("email");
        expect(String(body["Title"])).toBe(mail.subject);
        // The covering note, which the proposal keeps deliberately: "this is the dentist bill for
        // Anna" is context for the attachment, and `ExtractedText` is where the Receptionist looks.
        expect(String(body["ExtractedText"])).toContain("Zahnarztrechnung");
        // The attachment reached the Content Store and the Document points at it. This is the half
        // of the change that had no writer at all before it — the Runtime uploading a binary.
        expect(JSON.stringify(body["Attachment"] ?? null), "the PDF is on the Document").toContain("rechnung.pdf");

        // --- and the mailbox says what happened to the mail ------------------------------------
        //
        // Move last, after the final ADD_DOCUMENT returned. Read from the server rather than from a
        // log, and it is the folder that makes a crash between create and move recoverable.
        await waitFor(
            `the message to have been moved to ${MAILBOX_FOLDERS.processed}`,
            async () => ((await mailbox.count(MAILBOX_FOLDERS.processed)) ?? 0) >= 1 || undefined,
            60_000,
            1_000
        );
        expect(await mailbox.count(MAILBOX_FOLDERS.incoming), "nothing left in the incoming folder").toBe(0);
        // Created by the ingest itself, not by this spec — only `assistants` existed beforehand.
        expect(await mailbox.count(MAILBOX_FOLDERS.rejected), "the ingest created all four folders").toBe(0);

        // --- from here the Receptionist behaves as if someone had typed it in ------------------
        const documentThingId = thingIdOf(document.docRef);
        const born = await waitForBirth(store, documentThingId);
        expect(String(((born.document["Conversation"] ?? {}) as Record<string, unknown>)["AssistantKey"])).toBe(
            RECEPTIONIST
        );

        // --- and a question is waiting in the web application ----------------------------------
        const question = await waitForRaisedQuestion(store, documentThingId);
        const page = await getPageAs("admin");
        const openQuestion = new OpenQuestionPage(page);
        await openQuestion.openQuestion(question);
        await expect(openQuestion.markdownEditor("Question")).toContainText("Book this invoice?");
    });
});
