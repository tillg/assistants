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
    deleteAccount,
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
/** A demo budget with a limit set for the current month. */
const BUDGET = "Health";

/** Firefly needs both ends of a period to compute `spent`, and rejects start === end. */
function thisMonth(): { start: string; end: string } {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function firstOfThisMonth(): string {
    return thisMonth().start;
}

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
    const createdAccountIds: string[] = [];

    beforeAll(async () => {
        firefly = newFirefly();
    });

    afterEach(async () => {
        // Every transaction this suite posts is removed again, so the demo balances are the
        // ones the demo data seeded and nothing else — and so is every account it creates, or the
        // chart of accounts would grow a little on every run.
        while (postedIds.length > 0) await deleteTransaction(postedIds.pop()!);
        while (createdAccountIds.length > 0) await deleteAccount(createdAccountIds.pop()!);
    });

    afterAll(async () => {
        while (postedIds.length > 0) await deleteTransaction(postedIds.pop()!);
        while (createdAccountIds.length > 0) await deleteAccount(createdAccountIds.pop()!);
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

    it("reports a budget's target and what has been spent against it", async () => {
        // `listBudgets()` called `GET /budgets` with no period, and Firefly only computes `spent` for
        // a period — so it answered `spent: null`, which reads to a model as "nothing spent". It never
        // read the limits at all, so the *target* was not in the answer in any form. Both numbers
        // absent, from the Operation ACCOUNTING.md specifies as "actual vs. budget per account", with
        // ADR-0006 making Bookkeeping the Authority so nothing else can supply it.
        const spend = "200.00";
        const posted = await firefly.postTransaction({
            externalId: `${ITEST}budget:${Date.now()}`,
            splits: [
                {
                    type: "withdrawal",
                    date: firstOfThisMonth(),
                    amount: spend,
                    description: `${ITEST}against the Health budget`,
                    sourceAccount: SOURCE,
                    destinationAccount: "Expenses:Health",
                    budgetName: BUDGET,
                },
            ],
        });
        postedIds.push(posted.id);

        const report = await firefly.listBudgets(thisMonth());
        const health = report.find((budget) => budget.name === BUDGET);
        expect(health, `${BUDGET} is not in the budget report`).toBeDefined();
        // Both numbers, and `spent` as a number rather than Firefly's per-currency array.
        expect(Number(health!.spent)).toBeGreaterThanOrEqual(Number(spend));
        expect(Number(health!.limit)).toBeGreaterThan(0);

        // "Nothing spent" must be distinguishable from "unknown": Firefly answers `[]` for an unspent
        // budget, and reporting that as null is what made the original bug invisible.
        for (const budget of report) expect(budget.spent).not.toBeNull();
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

    it("can re-book a transaction the User deleted in Firefly, under its original key", async () => {
        // Firefly's duplicate-hash index survives a delete while its *search* does not, so the
        // connector's own probe said "not there" and Firefly then refused the post as
        // "Duplicate of transaction #14" — naming a journal that no longer exists. Permanent
        // deadlock for that key: the User's correction in Firefly left the Assistant unable ever to
        // redo the booking it is responsible for, with an error pointing at nothing.
        const externalId = `${ITEST}redo:${Date.now()}`;
        const input = {
            externalId,
            splits: [
                {
                    type: "withdrawal" as const,
                    date: new Date().toISOString().slice(0, 10),
                    amount: "7.77",
                    description: `${ITEST}deleted and re-booked`,
                    sourceAccount: SOURCE,
                    destinationAccount: DESTINATION,
                },
            ],
        };

        const first = await firefly.postTransaction(input);
        expect(first.alreadyExisted).toBe(false);

        // The User deletes it in Firefly, as a correction.
        await deleteTransaction(first.id);
        expect(await firefly.findByExternalId(externalId)).toBeUndefined();

        const again = await firefly.postTransaction(input);
        postedIds.push(again.id);
        expect(again.alreadyExisted).toBe(false);
        expect(again.id).not.toBe(first.id);
        // And it is findable by its key again, so idempotency still holds afterwards.
        expect((await firefly.findByExternalId(externalId))?.id).toBe(again.id);
    });

    it("two concurrent posts under one idempotency key produce one journal", async () => {
        // `postTransaction` probes for the key and then posts, with nothing between the two halves and
        // no uniqueness constraint on `external_id` behind them, so two callers interleaved both land.
        // Latent today — one Runtime replica, and a lease serialises a Conversation's Turns — but it is
        // the guarantee ADR-0012 and `reconcile()` lean on, so it should not quietly be false.
        const externalId = `${ITEST}race:${Date.now()}`;
        const split = (amount: string) => ({
            externalId,
            splits: [
                {
                    type: "withdrawal" as const,
                    date: new Date().toISOString().slice(0, 10),
                    amount,
                    description: `${ITEST}raced posting`,
                    sourceAccount: SOURCE,
                    destinationAccount: DESTINATION,
                },
            ],
        });

        const [a, b] = await Promise.all([
            firefly.postTransaction(split("11.11")),
            firefly.postTransaction(split("22.22")),
        ]);
        postedIds.push(a.id);
        if (b.id !== a.id) postedIds.push(b.id);

        // One of them did the work and the other recognised it, rather than both landing.
        expect(b.id).toBe(a.id);
        expect([a.alreadyExisted, b.alreadyExisted].filter(Boolean)).toHaveLength(1);
    });

    it("books one invoice once, even from two Conversations with different keys", async () => {
        // Two Turns, or two Conversations about one invoice, produce two different idempotency keys
        // for the same posting — and `external_id` participates in Firefly's duplicate hash, so
        // `error_if_duplicate_hash` cannot see them as duplicates. The live demo books already showed
        // twelve identical journals for one consultation, EUR 1,062 of them.
        //
        // The Invoice's ThingID is already written as a `thing:` tag, so this is a question the
        // connector can ask and never did.
        const thingId = `00000000-0000-4000-8000-${String(Date.now()).slice(-12)}`;
        const posting = (key: string) => ({
            externalId: key,
            thingId,
            splits: [
                {
                    type: "withdrawal" as const,
                    date: new Date().toISOString().slice(0, 10),
                    amount: "96.50",
                    description: `${ITEST}Consultation, one invoice`,
                    sourceAccount: SOURCE,
                    destinationAccount: DESTINATION,
                },
            ],
        });

        const first = await firefly.postTransaction(posting(`${ITEST}conv-a:1`));
        postedIds.push(first.id);
        const second = await firefly.postTransaction(posting(`${ITEST}conv-b:1`));
        if (second.id !== first.id) postedIds.push(second.id);

        expect(second.alreadyExisted).toBe(true);
        expect(second.id).toBe(first.id);
    });

    it("still books a second, genuinely different posting for the same invoice", async () => {
        // The guard above must not become "one transaction per Thing". ACCOUNTING.md gives one invoice
        // up to four legitimate journals — book the payable, pay it, claim from the insurer, the
        // insurer pays — all carrying the same ThingID. Deduplicating on the tag alone would make the
        // payment leg a silent no-op, which is worse than the bug it fixes.
        const thingId = `00000000-0000-4000-8000-${String(Date.now() + 1).slice(-12)}`;
        const leg = (key: string, amount: string, description: string) => ({
            externalId: key,
            thingId,
            splits: [
                {
                    type: "withdrawal" as const,
                    date: new Date().toISOString().slice(0, 10),
                    amount,
                    description,
                    sourceAccount: SOURCE,
                    destinationAccount: DESTINATION,
                },
            ],
        });

        const booked = await firefly.postTransaction(
            leg(`${ITEST}leg-a:1`, "96.50", `${ITEST}booked the payable`),
        );
        postedIds.push(booked.id);
        const paid = await firefly.postTransaction(
            leg(`${ITEST}leg-b:1`, "40.00", `${ITEST}part payment`),
        );
        postedIds.push(paid.id);

        expect(paid.alreadyExisted).toBe(false);
        expect(paid.id).not.toBe(booked.id);
    });

    it("refuses a foreign-currency amount rather than booking it as euros", async () => {
        // The report says the connector drops `currencyCode`. It does not — it sends
        // `currency_code` faithfully, and *Firefly* overrides it from the source asset account. So a
        // split posted as 50.00 USD was stored as 50.00 EUR: no error, no foreign-amount fields, no
        // conversion. A foreign-currency invoice booked at the wrong value with nothing to notice it
        // by, which for a Bookkeeping Authority (ADR-0006) means nothing holds a copy to disagree.
        //
        // ACCOUNTING.md lists multi-currency as "nice to have, not required", so refusing is in scope
        // and mis-booking is not.
        const externalId = `${ITEST}usd:${Date.now()}`;
        await expect(
            firefly.postTransaction({
                externalId,
                splits: [
                    {
                        type: "withdrawal",
                        date: new Date().toISOString().slice(0, 10),
                        amount: "50.00",
                        description: `${ITEST}a dollar invoice`,
                        sourceAccount: SOURCE,
                        destinationAccount: DESTINATION,
                        currencyCode: "USD",
                    },
                ],
            }),
        ).rejects.toThrow(/USD.*EUR|EUR.*USD/s);

        expect(await firefly.findByExternalId(externalId)).toBeUndefined();
    });

    it("refuses an ambiguous account name instead of silently picking one", async () => {
        // Firefly allows two accounts whose names differ only by case within one type, and one name
        // under two different types. `resolveAccountId` used three successive `find` calls, so it
        // returned whichever Firefly listed first — and worse, two *spellings* of one name resolved to
        // two different accounts. Name→id resolution exists precisely so the model cannot address the
        // wrong account.
        const base = `${ITEST}Ambig-${Date.now()}`;
        const created = [
            await firefly.createAccount({ name: base, type: "expense" }),
            await firefly.createAccount({ name: base.toLowerCase(), type: "expense" }),
        ];
        createdAccountIds.push(...created.map((account) => account.id));

        await expect(firefly.resolveAccountId(base.toUpperCase())).rejects.toThrow(/ambiguous/i);
        // An exact match is still unambiguous, so the ordinary path is untouched.
        expect(await firefly.resolveAccountId(base)).toBe(created[0]!.id);
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
