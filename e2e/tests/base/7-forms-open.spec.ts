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

/** module → a cell value present in that overview, and whether the form is known to be broken. */
const MODULES: ReadonlyArray<readonly [string, string, boolean]> = [
    ["Open Questions", "accountant", false],
    ["Documents", "post", false],
    ["Invoices", "EUR", false],
    ["Processes", "renovation", false],
    ["Parties", "organisation", false],
    ["Assistants", "receptionist", false],
    // Known broken, cause not isolated — see tmp/BUGS.md #4. Marked `fixme` rather than `fail`
    // because Conversations is *intermittent*: it loads on some runs. `test.fail()` would then
    // report "expected to fail, but passed" and turn a real bug into a flaky red herring.
    ["Conversations", "accountant", true],
    ["Runtime", "the-one", true]
];

for (const [module, cell, knownBroken] of MODULES) {
    test(`${module}: a row opens without a post-processing error`, async ({ getPageAs }) => {
        test.fixme(knownBroken, "known bug: the form engine rejects this form model (tmp/BUGS.md #4)");
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
