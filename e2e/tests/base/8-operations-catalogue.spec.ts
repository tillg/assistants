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
 * The catalogue of Operations, and the switch it exists for.
 *
 * An Operation is a Thing (ADR-0019), so "what can my Assistants actually do?" is answerable in
 * the ordinary web application rather than by reading `implementations.ts`. Two halves of that are
 * worth asserting and one of them is worth asserting end to end:
 *
 *   - the catalogue is **browsable and honest** — the columns are there, search narrows it, a row
 *     opens on the Operation it names, and the fields code owns cannot be typed over;
 *   - the `Enabled` box is a **kill switch that reaches the Runtime**. That is the whole point of
 *     putting the catalogue in the store: the Runtime loads it once per Turn, so a box unticked in
 *     the UI stops the next Turn offering that Operation — with no restart, no redeploy and no
 *     edit to the Assistant's grants, which are left exactly as they were.
 *
 * The observable signal for the second one is the Runtime's own sentence in the transcript. An
 * Operation that resolves to nothing is not an absence: the intent is written first, so the
 * refusal is an Entry, and it says *why* — "switched off", not "not one of your tools", which
 * would be false while the grant is still sitting in the Assistant's definition.
 *
 * **Why `bookkeeping.listAccounts`.** It has to be an Operation the scripted model actually calls,
 * or nothing is refused and the test proves nothing. Of those it is the only one that is read-only
 * (`mutating: false`) *and* the accountant's, so switching it off cannot touch anyone's books, and
 * — the reason it is the safe choice rather than merely a valid one — the invoice slice does not
 * depend on it: with the chart of accounts denied, the scripted accountant still asks the User,
 * still posts, still gets its approval. Were this switch ever to leak past the restore below, that
 * spec would still pass. Switching off `assistant.call` or `bookkeeping.postTransaction` would not
 * have that property.
 *
 * The Conversation this leaves behind is left waiting on the User, deliberately: answering it
 * would walk the whole invoice slice a second time and book a second transaction, and the refusal
 * has already been observed by then. Conversations and Open Questions are Runtime-owned and never
 * deleted by this suite (`0-clean.setup.ts`); the Document that started it carries the `E2E`
 * prefix, so the next run's clean-up takes it.
 */

import { expect, test } from "../../fixtures";
import { FormPage } from "../../pages/FormPage";
import { OverviewPage } from "../../pages/OverviewPage";
import { DataType, type TestData } from "../../types";
import { TestID } from "../../types/testIds";
import { createArrivingDocument, waitForToolResult } from "../../utils/agents";
import { AGENT_TIMEOUT_MS } from "../../utils/config";
import { eq, ThingStore } from "../../utils/thingstore";

const MODULE = "Operations";

/** The Operation switched off and on again — see the note at the top of this file. */
const KILL_SWITCH = "bookkeeping.listAccounts";

/** `Operation_OM`'s columns, in its order: the four questions the catalogue exists to answer. */
const COLUMNS = ["Key", "System", "Kind", "Enabled", "Requires approval", "Mutating"];

/** `Operation_OM`'s `pagingSize`. Seventeen Implementations are seeded, so page one is full. */
const PAGE_SIZE = 10;

const enabled = (value: "true" | "false"): TestData => ({
    label: "Enabled",
    // A `BooleanType` renders as a three-state select — empty / yes / no — not a checkbox.
    type: DataType.Select,
    value
});

let store: ThingStore;
let docRef: string;
let wasEnabled: unknown;

test.beforeAll(async () => {
    store = await ThingStore.connect("admin");
    const [operation] = await store.query("Operation_DM", eq("/Operation/Key", KILL_SWITCH));
    if (!operation) {
        throw new Error(`No Operation '${KILL_SWITCH}' in the catalogue — has \`just bootstrap\` run?`);
    }
    docRef = operation.docRef;
    wasEnabled = (operation.document["Operation"] as Record<string, unknown>)["Enabled"];
});

/**
 * Put the switch back even when the test failed with it off.
 *
 * The catalogue is shared state that the flow specs run against afterwards, and a half-finished
 * run must not be the reason one of them behaves differently. Bootstrap creates every Operation
 * with `enabled: true` and never re-applies it, so an unset value falls back to `true` rather than
 * being written back as nothing.
 */
test.afterAll(async () => {
    if (store && docRef) {
        await store.patch(docRef, "Operation", { Enabled: wasEnabled === undefined ? true : wasEnabled });
    }
});

/** Find one Operation in the catalogue and open its form. Its key is what the overview searches. */
async function openOperation(overview: OverviewPage, form: FormPage, key: string) {
    await overview.gotoHome();
    await overview.clickMenuItem(MODULE);
    await overview.search(key);
    await overview.openDocument(key);
    await form.toBeVisible();
}

test.describe.serial("Operations catalogue", () => {
    test("should list the catalogue, narrow it by search, and open an Operation", async ({ getPageAs }) => {
        const page = await getPageAs("admin");
        const overview = new OverviewPage(page);
        const form = new FormPage(page);

        await overview.gotoHome();
        await overview.clickMenuItem(MODULE);

        for (const column of COLUMNS) {
            await expect(page.getByRole("columnheader", { name: column })).toBeVisible();
        }

        // A full page of Operations — and no way to add an eighteenth. An Operation exists because
        // code implements it; the User owns the catalogue's decisions, not its membership.
        await expect(page.getByTestId(TestID.TABLE_BODY_ROW)).toHaveCount(PAGE_SIZE);
        await expect(page.getByRole("button", { name: "Add" })).toHaveCount(0);

        // --- search narrows it ------------------------------------------------------------------
        // `System` is indexed, so one word finds every Operation that touches the books — which is
        // the question a User with seventeen of them and ten rows per page actually has.
        await overview.search("bookkeeping");
        await expect(page.getByTestId(TestID.TABLE_BODY_ROW)).not.toHaveCount(0);
        await overview.assertDocumentsInTable([KILL_SWITCH, "bookkeeping.postTransaction"]);
        await overview.assertDocumentNotInTable("ui.askUser");

        // --- and a row opens on the Operation it names --------------------------------------------
        await overview.openDocument(KILL_SWITCH);
        await form.toBeVisible();
        await form.assertFieldValue({ label: "Key", value: KILL_SWITCH, type: DataType.String });

        // The description is the text the model is given, so a User reading it is reading what the
        // Assistant reads — and it renders as markdown, not as a `<textarea>` full of asterisks.
        const description = form.markdownEditor("Description");
        await expect(description).toBeVisible();
        await expect(description).toHaveAttribute("data-lexical-editor", "true");
        // Prose, not merely a control: an empty Lexical editor still renders a paragraph, so
        // "not empty" would pass on nothing at all. The wording is deliberately not asserted —
        // bootstrap reports a diverged description rather than re-applying it, so the seed's exact
        // sentence is not something a live stack guarantees.
        await expect(description).toContainText(/[A-Za-z]{4,}/);
    });

    test("should let the User edit what is theirs, and nothing the code owns", async ({ getPageAs }) => {
        const page = await getPageAs("admin");
        const overview = new OverviewPage(page);
        const form = new FormPage(page);

        await openOperation(overview, form, KILL_SWITCH);
        await form.startEditing();

        // Code owns these three: they mirror the Implementation and bootstrap re-applies them on
        // every run, so a User who edited one would watch their edit disappear.
        for (const label of ["Key", "System", "Kind"]) {
            expect(await form.isFieldEditable(label), `${label} mirrors the code and must be read-only`).toBe(false);
        }

        // These are the User's, in both directions: the name they read it by, and the switch.
        for (const label of ["Name", "Enabled"]) {
            expect(await form.isFieldEditable(label), `${label} is the User's and must be editable`).toBe(true);
        }
    });

    test("should stop offering an Operation the User switched off", async ({ getPageAs }) => {
        // A Document birth, a hand-off to a second Assistant and a two-second scan interval.
        test.setTimeout(AGENT_TIMEOUT_MS * 2);

        const page = await getPageAs("admin");
        const overview = new OverviewPage(page);
        const form = new FormPage(page);

        // --- the User switches it off, in the ordinary UI -----------------------------------------
        await openOperation(overview, form, KILL_SWITCH);
        await form.startEditing();
        await form.inputFieldValue(enabled("false"));
        await form.saveEdits();

        // `false`, not `"false"`. The registry disables on `enabled === false` — a strict
        // comparison, because an unset box means "not switched off" — so a form that wrote the
        // string would leave a kill switch that looks flipped and does nothing.
        expect((await store.body(docRef, "Operation"))["Enabled"]).toBe(false);

        // --- and a Conversation that would otherwise call it runs anyway ---------------------------
        // The grant is untouched: the accountant still has `bookkeeping.listAccounts` in its
        // definition, and the scripted model still asks for it on its first Turn.
        const document = await createArrivingDocument(store, `killswitch-${Date.now()}`);
        const refusal = await waitForToolResult(store, document.thingId, "is switched off");

        expect(String(refusal["ToolName"])).toBe(KILL_SWITCH);
        expect(String(refusal["ToolResult"])).toContain(
            `"${KILL_SWITCH}" is switched off. The User has disabled it, so nothing was done; ` +
                "ask them if you need it."
        );
        // It was not offered, rather than offered and refused: the Runtime lists what the Assistant
        // does have, and the Operation just switched off is not in it.
        expect(String(refusal["ToolResult"])).toContain("Available:");
        expect(String(refusal["ToolResult"]).split("Available:")[1] ?? "").not.toContain(KILL_SWITCH);

        // --- and the catalogue is left as it was found ---------------------------------------------
        await openOperation(overview, form, KILL_SWITCH);
        await form.startEditing();
        await form.inputFieldValue(enabled("true"));
        await form.saveEdits();
        expect((await store.body(docRef, "Operation"))["Enabled"]).toBe(true);
    });
});
