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
 * A Document whose attachment is a PDF shows its preview inline, without leaving the form.
 *
 * The preview (`client/src/components/document/DocumentAttachmentPane.tsx`) is a pure reader hung
 * beneath the Document form: it reads the persisted `Attachment` group off the open Document and,
 * for `application/pdf`, renders the browser's own PDF viewer in an iframe. So the only
 * setup this needs is a real Document with a real attachment in the Content Store — which is exactly
 * what the mail ingest produces, minus the mail. This spec produces it directly through the API.
 *
 * It **creates its own Document** rather than leaning on the demo household, stamped `Source: "E2E"`
 * and an `E2E`-prefixed `Title` so `0-clean.setup.ts` reclaims it — that pass deletes a Document whose
 * `Title` carries the `E2E` marker **and** whose `Source` is not `email` (the ingest's own value), so
 * both fields here matter: the prefix marks it, the non-`email` Source keeps it clear of the demo
 * household. Clean-up is left to that pass on
 * purpose: it deletes with the Runtime paused, and deleting a freshly-created Document here could
 * strand the Conversation the trigger watcher may already have born for it (the hazard `0-clean`
 * documents). This is the same arrangement `flow/0-mail-arrives.spec.ts` uses for the Documents it
 * leaves behind.
 *
 * The attachment goes to the Content Store the way the platform's own uploader and the Runtime's
 * mail ingest send it — see `ThingStore.uploadAttachment` — and the resulting group object is stored
 * under the Document's `Attachment`, reproducing the persisted shape `0-mail-arrives` asserts.
 */

import path from "node:path";

import { expect, test } from "../../fixtures";
import { FormPage } from "../../pages/FormPage";
import { OverviewPage } from "../../pages/OverviewPage";
import { E2E_PREFIX, REPO_ROOT } from "../../utils/config";
import { nowIso, ThingStore } from "../../utils/thingstore";

/** A one-page PDF fixture — enough for the `application/pdf` renderer to pick and the frame to mount. */
const PDF_FIXTURE = path.join(REPO_ROOT, "e2e", "fixtures", "attachment.pdf");
const PDF_MIME = "application/pdf";

test.describe("Attachment preview", () => {
    test("shows an inline PDF preview on a Document whose attachment is a PDF", async ({ getPageAs }) => {
        test.setTimeout(120_000);

        const runId = String(Date.now());
        const title = `${E2E_PREFIX} PDF preview ${runId}`;

        // --- setup: a Document with a real PDF attachment, through the API --------------------
        const store = await ThingStore.connect("admin");
        const attachment = await store.uploadAttachment(PDF_FIXTURE, PDF_MIME);
        await store.addDocument("Document_DM", {
            Document: {
                Title: title,
                ReceivedAt: nowIso(),
                // The field `0-clean.setup.ts` keys its exact-match delete on. Never `email`, which
                // only the ingest writes — this is a Thing the e2e suite created.
                Source: E2E_PREFIX,
                MediaType: PDF_MIME,
                ExtractedText: "An E2E fixture invoice, attached as a PDF.",
                IdempotencyKey: `${E2E_PREFIX}:document:${runId}`,
                // `repeatability: 1`, so A12 wants the group as a plain object, not an array — the
                // exact shape `ContentStoreClient.upload` returns and the mail ingest stores.
                Attachment: attachment
            }
        });

        // --- open that Document's form in the web application --------------------------------
        const page = await getPageAs("admin");
        const overview = new OverviewPage(page);
        const form = new FormPage(page);

        await overview.gotoHome();
        await overview.clickMenuItem("Documents");
        // The overview shows one page; search narrows to this run's Document wherever it sorts.
        await overview.search(title);
        await overview.openDocument(title);
        await form.toBeVisible();

        // --- the preview is there ------------------------------------------------------------
        // testIdAttribute is `data-role`, so these resolve to the panes the component renders.
        await expect(page.getByTestId("document-attachment-preview"), "the preview pane is present").toBeVisible();
        await expect(
            page.getByTestId("attachment-preview-pdf"),
            "the PDF renders in the browser's viewer iframe"
        ).toBeVisible();
    });
});
