/**
 * Every form opens.
 *
 * The navigation spec asserts each *overview* renders, which is not the same thing: the
 * Conversation form threw `Post processing for model "Conversation_FM" failed` and rendered
 * nothing at all, for days, with 21 other specs green. A form model can be structurally valid,
 * convert cleanly, and still be rejected by the form engine at runtime.
 */
import { expect, test } from "../../fixtures";
import { BasePage } from "../../pages/BasePage";

/** module → a cell value present in that overview. */
const MODULES: ReadonlyArray<readonly [string, string]> = [
    ["Open Questions", "accountant"],
    ["Documents", "post"],
    ["Invoices", "EUR"],
    ["Processes", "renovation"],
    ["Parties", "organisation"],
    ["Assistants", "receptionist"],
    // Conversations and Runtime were `fixme` while the cause was unknown: both form models were
    // missing `content.subHeaderBox`, which the form engine's own gate requires (BUG-15). The
    // apparent intermittency was this spec, not the models — see the wait below.
    ["Conversations", "accountant"],
    ["Runtime", "the-one"]
];

for (const [module, cell] of MODULES) {
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

        const rows = page.getByRole("cell", { name: cell, exact: true });
        if ((await rows.count()) === 0) {
            test.skip(true, `no row matching "${cell}" in ${module} — nothing to open`);
        }
        await rows.first().click();
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
