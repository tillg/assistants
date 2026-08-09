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

/** module → a cell value that is present in that overview and opens a row. */
const MODULES: ReadonlyArray<readonly [string, string]> = [
    ["Open Questions", "accountant"],
    ["Documents", "post"],
    ["Invoices", "EUR"],
    ["Processes", "renovation"],
    ["Parties", "organisation"],
    ["Assistants", "receptionist"],
    ["Conversations", "accountant"],
    ["Runtime", "the-one"]
];

for (const [module, cell] of MODULES) {
    test(`${module}: a row opens without a post-processing error`, async ({ getPageAs }) => {
        const page = await getPageAs("admin");
        const errors: string[] = [];
        page.on("console", (message) => {
            if (message.type() === "error") errors.push(message.text());
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

        const postProcessing = errors.filter((error) => error.includes("Post processing"));
        expect(postProcessing, `${module} form failed to load`).toHaveLength(0);
    });
}
