/**
 * The Bookkeeping Connector against the real Firefly III.
 *
 * Two of the Connector's guarantees are only guarantees against a real Firefly:
 *
 *   1. **It never lets Firefly invent an account.** Firefly auto-creates an expense or revenue
 *      account when handed an unknown *name*, so a hallucinated account would succeed silently.
 *      A stub cannot demonstrate that the Connector avoids this; only posting through the real
 *      API and counting the accounts afterwards can.
 *   2. **Posting is idempotent under `external_id`.** That relies on Firefly's own transaction
 *      search seeing the write, which is the part a fake always gets right and a real system
 *      might not.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FireflyConnector, FireflyError } from "../../src/connectors/firefly.js";
import {
    deleteTransaction,
    FIREFLY_TOKEN,
    FIREFLY_UP,
    FIREFLY_URL,
    ITEST,
    newFirefly,
    unique,
} from "./support/live.js";

const SOURCE = "Checking";
const DESTINATION = "Expenses:Household";
/** The demo household's payables account, which carries what is still owed. */
const PAYABLES = "Payables";

/** Firefly's categories, read raw — the Connector has no reason to expose a list of them. */
async function listCategoryNames(): Promise<string[]> {
    const response = await fetch(`${FIREFLY_URL.replace(/\/+$/, "")}/api/v1/categories?limit=200`, {
        headers: { Authorization: `Bearer ${FIREFLY_TOKEN}`, Accept: "application/json" },
    });
    const payload = (await response.json()) as {
        data?: Array<{ attributes?: { name?: string } }>;
    };
    return (payload.data ?? []).map((row) => String(row.attributes?.name ?? "")).sort();
}

describe.skipIf(!FIREFLY_UP)("Firefly connector against the live Firefly III", () => {
    let firefly: FireflyConnector;
    const postedIds: string[] = [];

    beforeAll(async () => {
        firefly = newFirefly();
    });

    afterEach(async () => {
        // Every transaction this suite posts is removed again, so the demo balances are the
        // ones the demo data seeded and nothing else.
        while (postedIds.length > 0) await deleteTransaction(postedIds.pop()!);
    });

    afterAll(async () => {
        while (postedIds.length > 0) await deleteTransaction(postedIds.pop()!);
    });

    it("lists the demo accounts", async () => {
        const accounts = await firefly.listAccounts(true);
        expect(accounts.length).toBeGreaterThan(0);
        const names = accounts.map((account) => account.name);
        expect(names).toContain(SOURCE);
        expect(names).toContain(DESTINATION);
        for (const account of accounts) {
            expect(account.id).toMatch(/^\d+$/);
            expect(account.type).toBeTruthy();
        }
    });

    it("resolves a known account name to its id", async () => {
        const accounts = await firefly.listAccounts(true);
        const expected = accounts.find((account) => account.name === SOURCE)!;
        expect(await firefly.resolveAccountId(SOURCE)).toBe(expected.id);
        // Case and surrounding whitespace are tolerated; inventing an account is not.
        expect(await firefly.resolveAccountId(`  ${SOURCE.toLowerCase()} `)).toBe(expected.id);
    });

    it("throws for an unknown account rather than letting Firefly create it", async () => {
        const before = await firefly.listAccounts(true);
        const bogus = `${ITEST}no-such-account-${Date.now()}`;

        await expect(firefly.resolveAccountId(bogus)).rejects.toBeInstanceOf(FireflyError);
        await expect(firefly.resolveAccountId(bogus)).rejects.toThrow(/No account named/);

        const after = await firefly.listAccounts(true);
        expect(after.map((account) => account.name)).not.toContain(bogus);
        expect(after).toHaveLength(before.length);
    });

    it("lists a payable with a non-zero balance as an open item", async () => {
        // Firefly's *write* API takes `type: "liability"`; its *read* API answers `"liabilities"`.
        // Matching only the singular made `listOpenItems` return an empty list while thousands were
        // owed — and the Accountant's own skill says to report from this call and nothing else, so it
        // stated confidently that nothing was outstanding. Fixed in 495310a and guarded by nothing:
        // the unit fake returns `[]`, so it agreed with the bug.
        //
        // The plural is asserted explicitly. That single word is the whole of the regression.
        const items = await firefly.listOpenItems();
        const payables = items.find((account) => account.name === PAYABLES);
        expect(payables, `${PAYABLES} is not reported as an open item`).toBeDefined();
        expect(payables!.type).toBe("liabilities");
        expect(Math.abs(Number(payables!.currentBalance))).toBeGreaterThan(0);
    });

    it("does not offer Firefly's internal accounts as bookable", async () => {
        // `bookkeeping.listAccounts` hands this list straight to the model as the chart of accounts,
        // with the instruction "always look here before booking". It included
        // `Initial balance for "Checking"` — type `initial-balance` — which is Firefly's own
        // bookkeeping and cannot be posted to: all three directions come back 422 quoting an internal
        // id and an empty name, which tells the model nothing it can act on.
        const accounts = await firefly.listAccounts(true);
        expect(accounts.map((account) => account.type)).not.toContain("initial-balance");
        expect(accounts.map((account) => account.name)).not.toContain('Initial balance for "Checking"');
        await expect(
            firefly.resolveAccountId('Initial balance for "Checking"'),
        ).rejects.toThrow(/No account named/);

        // The same filter is what could silently drop `Payables` if the plural were got wrong, which
        // would resurrect BUG-02 in a worse form. Asserted here, next to the filter it guards.
        expect(accounts.map((account) => account.name)).toContain(PAYABLES);
        expect(accounts.map((account) => account.name)).toContain(SOURCE);
        expect(accounts.map((account) => account.name)).toContain(DESTINATION);
    });

    it("reads a balance", async () => {
        const balance = await firefly.getBalance(SOURCE);
        expect(balance.account).toBe(SOURCE);
        expect(Number(balance.balance)).not.toBeNaN();
        expect(balance.currency).toMatch(/^[A-Z]{3}$/);
    });

    it("posts a transaction once for a repeated externalId", async () => {
        // No colon in the key: see the `it.fails` below for why that matters.
        const externalId = `itest-posting-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const thingId = "00000000-0000-0000-0000-0000000000ff";
        const input = {
            groupTitle: `${ITEST}posting`,
            externalId,
            thingId,
            splits: [
                {
                    type: "withdrawal" as const,
                    date: new Date().toISOString().slice(0, 10),
                    amount: "1.23",
                    description: `${ITEST}idempotent posting`,
                    sourceAccount: SOURCE,
                    destinationAccount: DESTINATION,
                    notes: "posted by the integration tier",
                },
            ],
        };

        const first = await firefly.postTransaction(input);
        postedIds.push(first.id);
        expect(first.alreadyExisted).toBe(false);
        expect(first.id).toMatch(/^\d+$/);

        const second = await firefly.postTransaction(input);
        expect(second.alreadyExisted).toBe(true);
        expect(second.id).toBe(first.id);

        const found = await firefly.findByExternalId(externalId);
        expect(found?.id).toBe(first.id);

        // And exactly one group carries the key. The window has to be strictly wider than a
        // day: Firefly rejects `start === end` with "The start must be a date before end".
        const day = 86_400_000;
        const transactions = await firefly.listTransactions({
            start: new Date(Date.now() - day).toISOString().slice(0, 10),
            end: new Date(Date.now() + day).toISOString().slice(0, 10),
            accountName: SOURCE,
            limit: 50,
        });
        const mine = transactions.filter((group) => {
            const splits = (group as { attributes?: { transactions?: Array<Record<string, unknown>> } })
                .attributes?.transactions;
            return (splits ?? []).some((split) => split["external_id"] === externalId);
        });
        expect(mine).toHaveLength(1);
    });

    it(
        "an externalId containing ':' — the real Runtime key shape — is found, so posting is idempotent",
        async () => {
            // `LoopDriver` builds the key as `${conversationThingId}:${seq}`. Firefly's search
            // grammar is `field:value`, so an unquoted colon splits the term and matches nothing —
            // which silently voided the "ask, don't re-execute" guarantee lease recovery depends
            // on. The Connector quotes the value; this test is what holds it to that.
            // A fresh conversation-shaped id per run: Firefly's `error_if_duplicate_hash` hashes the
            // transaction's content and remembers deleted ones, so a fixed amount and description
            // would collide with a previous run rather than exercising the search.
            const suffix = unique("x").replace(/[^a-z0-9]/gi, "").slice(-12);
            const externalId = `00000000-0000-0000-0000-${suffix.padStart(12, "0")}:3`;
            const input = {
                externalId,
                splits: [
                    {
                        type: "withdrawal" as const,
                        date: new Date().toISOString().slice(0, 10),
                        amount: "3.45",
                        description: `${ITEST}colon key`,
                        sourceAccount: SOURCE,
                        destinationAccount: DESTINATION,
                    },
                ],
            };
            const first = await firefly.postTransaction(input);
            postedIds.push(first.id);
            const found = await firefly.findByExternalId(externalId);
            expect(found?.id).toBe(first.id);
        },
    );

    it("refuses an unknown category instead of letting Firefly create it", async () => {
        // The file's own header says the connector exists so that "Firefly never invents an account",
        // because a hallucinated name would *succeed* and corrupt a balance no test would catch. That
        // was implemented for accounts and not for categories, on the same request: a typo
        // (`categoryName: "Medcal"`) created a category.
        //
        // Budgets behave the opposite way and already fail loudly, which is why only categories needed
        // this.
        const before = await listCategoryNames();
        const externalId = `${ITEST}bad-category:${Date.now()}`;
        // Unique per run. A fixed name would be *created* by the first (red) run and then found by
        // the fix, so the test would pass for the wrong reason ever after — which is exactly what
        // happened while writing it.
        const bogus = `${ITEST}Medcal-${Date.now()}`;

        await expect(
            firefly.postTransaction({
                externalId,
                splits: [
                    {
                        type: "withdrawal",
                        date: new Date().toISOString().slice(0, 10),
                        amount: "1.00",
                        description: `${ITEST}should never land`,
                        sourceAccount: SOURCE,
                        destinationAccount: DESTINATION,
                        categoryName: bogus,
                    },
                ],
            }),
        ).rejects.toThrow(/No category named/);

        // Nothing landed, and no category was invented on the way.
        expect(await firefly.findByExternalId(externalId)).toBeUndefined();
        expect(await listCategoryNames()).toEqual(before);
    });

    it("refuses to post to an account that does not exist", async () => {
        const externalId = `${ITEST}bad-account:${Date.now()}`;
        await expect(
            firefly.postTransaction({
                externalId,
                splits: [
                    {
                        type: "withdrawal",
                        date: new Date().toISOString().slice(0, 10),
                        amount: "1.00",
                        description: `${ITEST}should never land`,
                        sourceAccount: SOURCE,
                        destinationAccount: `${ITEST}Expenses:Helth`,
                    },
                ],
            }),
        ).rejects.toThrow(/No account named/);

        // Nothing landed, and no account was invented on the way.
        expect(await firefly.findByExternalId(externalId)).toBeUndefined();
        const accounts = await firefly.listAccounts(true);
        expect(accounts.map((account) => account.name)).not.toContain(`${ITEST}Expenses:Helth`);
    });
});
