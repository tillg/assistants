import { describe, expect, it } from "vitest";

import { buildHarness } from "../support/harness.js";
import type { OperationContext } from "../../src/operations/registry.js";

/**
 * `bookkeeping.listAccounts`' type filter.
 *
 * The Accounts Tile wants *bank accounts* — Firefly's `asset` type — and the filter exists so that
 * the mapping from "bank account" to `"asset"` lives here, on the Connector's side, rather than as a
 * literal string inside a React component. Translation belongs where the other translation is.
 *
 * The `liability` / `liabilities` case is the one worth a test of its own: Firefly's read API answers
 * the plural and its write API accepts the singular, and a filter that knew only one of them would
 * repeat BUG-02 — where a type vocabulary that had never heard `liabilities` hid the payables account
 * entirely, and the Accountant then reported confidently that nothing was outstanding.
 */

const NO_CONTEXT = undefined as unknown as OperationContext;

async function listAccounts(args: Record<string, unknown>) {
    const harness = buildHarness([]);
    const outcome = await harness.registry.get("bookkeeping.listAccounts")!.execute(args, NO_CONTEXT);
    if (outcome.kind !== "value") throw new Error(`expected a value, got ${outcome.kind}`);
    return outcome.value as Array<{ name: string; type: string; currency?: string }>;
}

describe("bookkeeping.listAccounts", () => {
    it("lists the whole chart of accounts when asked for no type in particular", async () => {
        const accounts = await listAccounts({});

        expect(accounts.map((account) => account.name)).toEqual([
            "Checking",
            "Payables",
            "Expenses:Health",
        ]);
    });

    it("narrows to the bank accounts — what the Dashboard means by an account", async () => {
        const accounts = await listAccounts({ type: "asset" });

        expect(accounts.map((account) => account.name)).toEqual(["Checking"]);
        expect(accounts[0]?.currency).toBe("EUR");
    });

    it("answers the same for `liability` and `liabilities`, because Firefly does not", async () => {
        // Firefly's read API says `liabilities`; its write API takes `liability`. A caller should not
        // have to know which side of it they are on.
        expect((await listAccounts({ type: "liabilities" })).map((a) => a.name)).toEqual(["Payables"]);
        expect((await listAccounts({ type: "liability" })).map((a) => a.name)).toEqual(["Payables"]);
    });

    it("ignores case and stray whitespace rather than silently returning nothing", async () => {
        // An empty list is a statement about the household's money. Returning one because a caller
        // typed "Asset" would be the wrong kind of strictness.
        expect((await listAccounts({ type: "  ASSET " })).map((a) => a.name)).toEqual(["Checking"]);
    });

    it("returns nothing for a type that exists nowhere, rather than everything", async () => {
        // The failure mode that matters is the inverse: a filter that fell back to "all" on an
        // unknown type would put expense accounts on a tile headed "bank accounts".
        expect(await listAccounts({ type: "not-a-type" })).toEqual([]);
    });
});
