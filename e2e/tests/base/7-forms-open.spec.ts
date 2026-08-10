/**
 * Every form opens.
 *
 * The navigation spec asserts each *overview* renders, which is not the same thing: the
 * Conversation form threw `Post processing for model "Conversation_FM" failed` and rendered
 * nothing at all, for days, with 21 other specs green. A form model can be structurally valid,
 * convert cleanly, and still be rejected by the form engine at runtime.
 *
 * It opens **whatever the first row happens to be**, deliberately. This spec used to name a cell
 * value per module and skip when it did not match — and "Invoices" named `EUR`, which `Invoice_OM`
 * has no column for, so that module was skipped on every run since the file was written and its
 * guard was inert. Naming a value couples a structural guard to the demo fixtures, and an overview
 * shows only its first page, so any particular value can also fall off the end. A skip here now
 * means the overview is genuinely empty.
 */
import { expect, test } from "../../fixtures";
import { BasePage } from "../../pages/BasePage";

const MODULES: readonly string[] = [
    "Open Questions",
    "Documents",
    "Invoices",
    "Processes",
    "Parties",
    "Assistants",
    // Conversations and Runtime were `fixme` while the cause was unknown: both form models were
    // missing `content.subHeaderBox`, which the form engine's own gate requires (BUG-15). The
    // apparent intermittency was this spec, not the models — see the wait below.
    "Conversations",
    "Runtime"
];

for (const module of MODULES) {
    test(`${module}: a row opens without a post-processing error`, async ({ getPageAs }) => {
        const page = await getPageAs("admin");
        const errors: string[] = [];
        page.on("console", (message) => {
            if (message.type() === "error") {
                errors.push(message.text());
            }
        });

        const base = new BasePage(page);
        await base.gotoHome();
        await base.clickMenuItem(module);

        // The header is `columnheader`, so the first `cell` is the first data row's first column.
        const firstCell = page.getByRole("cell").first();
        if ((await page.getByRole("cell").count()) === 0) {
            test.skip(true, `${module} has no rows at all — nothing to open`);
        }
        await firstCell.click();
        await base.finishedLoading();

        // Wait for the form to actually be there, rather than only for the absence of an error.
        // `finishedLoading()` snapshots the overlays that exist *at call time*, so if none had
        // appeared yet it returned instantly and the console error had not been emitted — which is
        // the whole of the "intermittency" these two tests were `fixme`d for.
        await expect(page.getByRole("form").first(), `${module} form did not render`).toBeVisible({
            timeout: 15_000
        });

        const postProcessing = errors.filter((error) => error.includes("Post processing"));
        expect(postProcessing, `${module} form failed to load`).toHaveLength(0);
    });
}
