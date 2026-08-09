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
 * An Assistant's `systemPrompt` is a markdown field, and this proves the three coordinated facts
 * that make it one: `lineBreaksPermitted` on the `StringType`, `exposition: AREA` in the form
 * model, and the `widget: markdown-editor` annotation on the Control.
 *
 * The observable difference is structural, not cosmetic: the default widget map would render a
 * plain `<textarea>`; the annotation swaps in a Lexical `contenteditable` with a toolbar. The
 * value stored is still markdown, so the assertion that matters is the round trip — type
 * markdown, save, come back, and find both the rendered structure and the source text intact.
 */

import { expect, test } from "../../fixtures";
import { FormPage } from "../../pages/FormPage";
import { OverviewPage } from "../../pages/OverviewPage";
import { RECEPTIONIST } from "../../utils/agents";
import { eq, ThingStore } from "../../utils/thingstore";

const LABEL = "System prompt";
const HEADING = `E2E prompt ${Date.now()}`;
const MARKDOWN = `## ${HEADING}\nThe **Receptionist** reads this.`;

let store: ThingStore;
let docRef: string;
let originalPrompt: string;

test.beforeAll(async () => {
    store = await ThingStore.connect("admin");
    const [assistant] = await store.query("Assistant_DM", eq("/Assistant/Key", RECEPTIONIST));
    if (!assistant) {
        throw new Error(`No Assistant with key '${RECEPTIONIST}' — has \`just bootstrap\` run?`);
    }
    docRef = assistant.docRef;
    originalPrompt = String((assistant.document["Assistant"] as Record<string, unknown>)["SystemPrompt"] ?? "");
});

// An Assistant is a Thing the User owns and edits (ADR-0003); put the seeded prompt back so the
// next run — and the flow tests — start from what `just bootstrap` loaded.
test.afterAll(async () => {
    if (store && docRef) {
        await store.patch(docRef, "Assistant", { SystemPrompt: originalPrompt });
    }
});

test.describe("Markdown editor", () => {
    test("should edit the Receptionist's system prompt as markdown and round-trip it", async ({ getPageAs }) => {
        test.setTimeout(120_000);

        const page = await getPageAs("admin");
        const overview = new OverviewPage(page);
        const form = new FormPage(page);

        await overview.gotoHome();
        await overview.clickMenuItem("Assistants");
        await overview.openDocument(RECEPTIONIST);
        await form.toBeVisible();
        await form.startEditing();

        // --- it is the rich editor, not a text area ------------------------------------------
        const editor = form.markdownEditor(LABEL);
        await expect(editor).toBeVisible();
        await expect(editor).toHaveAttribute("contenteditable", "true");
        await expect(editor).toHaveAttribute("data-lexical-editor", "true");
        expect(await editor.evaluate((element) => element.tagName)).not.toBe("TEXTAREA");
        await expect(form.markdownToolbar()).toBeVisible();

        // --- type markdown -------------------------------------------------------------------
        await form.typeMarkdown(LABEL, MARKDOWN);
        // The markdown shortcuts fired while typing: `## ` became a heading, `**…**` became bold.
        await expect(editor.locator("h2")).toContainText(HEADING);
        await expect(editor.locator("strong")).toContainText("Receptionist");

        await form.saveEdits();

        // --- it round-tripped ------------------------------------------------------------------
        await overview.gotoHome();
        await overview.clickMenuItem("Assistants");
        await overview.openDocument(RECEPTIONIST);
        await form.toBeVisible();

        const reloaded = form.markdownEditor(LABEL);
        await expect(reloaded.locator("h2")).toContainText(HEADING);
        await expect(reloaded.locator("strong")).toContainText("Receptionist");

        // And what was stored is markdown, not HTML — the field is a String, after all.
        const stored = String((await store.body(docRef, "Assistant"))["SystemPrompt"] ?? "");
        expect(stored).toContain(`## ${HEADING}`);
        expect(stored).toContain("**Receptionist**");
    });
});
