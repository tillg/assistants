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
import { deleteTransaction, FIREFLY_UP, ITEST, newFirefly } from "./support/live.js";

const SOURCE = "Checking";
const DESTINATION = "Expenses:Household";

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

        // And exactly one group carries the key.
        const today = new Date().toISOString().slice(0, 10);
        const transactions = await firefly.listTransactions({
            start: today,
            end: today,
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

    it.fails(
        "known defect · an externalId containing ':' is invisible to findByExternalId, so posting is not idempotent for real Runtime keys",
        async () => {
            // `LoopDriver` builds the key as `${conversationThingId}:${seq}` and hands it to the
            // Connector as `external_id`. Firefly's search grammar is `field:value`, so the colon
            // splits the term and `external_id_is:<uuid>:3` matches nothing — the "ask, don't
            // re-execute" guarantee that lease recovery depends on silently does not hold.
            // What actually stops a double booking today is `error_if_duplicate_hash`, which
            // surfaces as a 422 rather than as an idempotent success.
            const externalId = `00000000-0000-0000-0000-0000000000fe:3`;
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
