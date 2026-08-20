/**
 * The seven `bookkeeping.*` Operations as Dynamic Operations, through the Operation Host, against the
 * real Firefly III (ADR-0025).
 *
 * This is the plan's "one layer out" proof: the same guarantees `firefly.itest.ts` asserts of the
 * compiled Connector — never let Firefly invent an account, `external_id` idempotency, the
 * `liabilities`/`liability` spelling, the mandatory budget period — now proven of the stored *source*
 * run by the Operation Host. It talks to the stack `just dev` brings up; absent stack ⇒ skipped.
 *
 * The Operation Host reaches Firefly through the `bookkeeping` egress, resolved here to the live
 * Firefly's URL and token. Everything created carries a unique name and is deleted afterwards, so a
 * run leaves the demo household's books as it found them.
 */

import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { OperationHost } from "../../src/operations/dynamic/host.js";
import type { DynamicOperationConfig } from "../../src/config.js";
import type { OperationContext, OperationOutcome } from "../../src/operations/registry.js";
import { deleteAccount, deleteTransaction, FIREFLY_TOKEN, FIREFLY_UP, FIREFLY_URL, unique } from "./support/live.js";

const DIR = new URL("../../../import/operations/bookkeeping/", import.meta.url);
const PRELUDE = readFileSync(new URL("prelude.ts", DIR), "utf8");
const source = (op: string) => PRELUDE + "\n" + readFileSync(new URL(`${op}.ts`, DIR), "utf8");

function makeHost(): OperationHost {
    const config: DynamicOperationConfig = {
        timeoutMs: 30_000,
        maxBodyBytes: 8 * 1024 * 1024,
        memoryMb: 128,
        cacheTtlMs: 300_000,
        egresses: { bookkeeping: { url: FIREFLY_URL, token: FIREFLY_TOKEN } },
    };
    return new OperationHost(config);
}

const SOURCE = "Checking";
const DESTINATION = "Expenses:Household";
const PAYABLES = "Payables";
const BUDGET = "Health";

function thisMonth(): { start: string; end: string } {
    const now = new Date();
    return {
        start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10),
        end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10),
    };
}

describe.skipIf(!FIREFLY_UP)("Dynamic bookkeeping Operations against the live Firefly III", () => {
    let host: OperationHost;
    const postedIds: string[] = [];
    const createdAccountIds: string[] = [];

    beforeAll(() => {
        host = makeHost();
    });

    afterEach(async () => {
        while (postedIds.length) await deleteTransaction(postedIds.pop()!);
        while (createdAccountIds.length) await deleteAccount(createdAccountIds.pop()!);
    });

    afterAll(async () => {
        while (postedIds.length) await deleteTransaction(postedIds.pop()!);
        while (createdAccountIds.length) await deleteAccount(createdAccountIds.pop()!);
    });

    async function run(
        op: string,
        args: Record<string, unknown>,
        mode: "execute" | "reconcile" = "execute",
        idempotencyKey = unique(`bk:${op}`),
    ): Promise<OperationOutcome | undefined> {
        const context = { idempotencyKey } as unknown as OperationContext;
        return host.run(host.compile(source(op)), mode, args, context, {
            key: `bookkeeping.${op}`,
            egress: "bookkeeping",
        });
    }

    function value<T>(outcome: OperationOutcome | undefined): T {
        expect(outcome?.kind, JSON.stringify(outcome)).toBe("value");
        return (outcome as { value: T }).value;
    }

    it("lists the chart of accounts, including the demo accounts", async () => {
        const accounts = value<Array<{ name: string; currency?: string }>>(await run("listAccounts", {}));
        const names = accounts.map((a) => a.name);
        expect(names).toContain(SOURCE);
        expect(names).toContain(PAYABLES);
    });

    it("answers `liability` the same as `liabilities` (BUG-02)", async () => {
        const singular = value<Array<{ name: string }>>(await run("listAccounts", { type: "liability" }));
        const plural = value<Array<{ name: string }>>(await run("listAccounts", { type: "liabilities" }));
        expect(singular.map((a) => a.name).sort()).toEqual(plural.map((a) => a.name).sort());
        expect(plural.some((a) => a.name === PAYABLES)).toBe(true);
    });

    it("reads one account's balance, resolving the name to an id", async () => {
        const balance = value<{ account: string; currency: string }>(await run("getBalance", { account: SOURCE }));
        expect(balance.account).toBe(SOURCE);
        expect(balance.currency).toBeTruthy();
    });

    it("refuses an unknown account by name, naming what exists", async () => {
        const outcome = await run("getBalance", { account: `${SOURCE} does not exist ${Date.now()}` });
        expect(outcome?.kind).toBe("error");
        expect((outcome as { message: string }).message).toMatch(/No account named/i);
    });

    it("lists transactions in a window, projected to the model's fields", async () => {
        const { start, end } = thisMonth();
        const rows = value<Array<Record<string, unknown>>>(await run("listTransactions", { start, end, limit: 5 }));
        expect(Array.isArray(rows)).toBe(true);
    });

    it("refuses a non-ISO date before calling Firefly", async () => {
        const outcome = await run("listTransactions", { start: "last week", end: thisMonth().end });
        expect(outcome?.kind).toBe("error");
        expect((outcome as { message: string }).message).toContain("yyyy-mm-dd");
    });

    it("reports budgets for the period, with spent as a number", async () => {
        const budgets = value<Array<{ name: string; spent: number }>>(await run("getBudgetReport", {}));
        const health = budgets.find((b) => b.name === BUDGET);
        if (health) expect(typeof health.spent).toBe("number");
    });

    it("creates an account, then finds it — and is idempotent on the name", async () => {
        const name = `Expenses:ITest ${Date.now()}`;
        const created = value<{ id: string; name: string; alreadyExisted?: boolean }>(
            await run("createAccount", { name, type: "expense" }),
        );
        createdAccountIds.push(created.id);
        expect(created.name).toBe(name);

        const again = value<{ id: string; alreadyExisted?: boolean }>(await run("createAccount", { name, type: "expense" }));
        expect(again.alreadyExisted).toBe(true);
        expect(again.id).toBe(created.id);
    });

    it("books a transaction, and is idempotent under the same key", async () => {
        const key = unique("bk:post");
        const args = {
            groupTitle: `ITest ${Date.now()}`,
            splits: [
                {
                    type: "withdrawal",
                    date: thisMonth().start,
                    amount: "12.34",
                    description: "Dynamic Operation integration test",
                    sourceAccount: SOURCE,
                    destinationAccount: DESTINATION,
                },
            ],
        };
        const first = value<{ transactionId: string; alreadyExisted: boolean }>(
            await run("postTransaction", args, "execute", key),
        );
        postedIds.push(first.transactionId);
        expect(first.alreadyExisted).toBe(false);

        // Same key again: recognised, not double-booked.
        const second = value<{ transactionId: string; alreadyExisted: boolean }>(
            await run("postTransaction", args, "execute", key),
        );
        expect(second.alreadyExisted).toBe(true);
        expect(second.transactionId).toBe(first.transactionId);

        // reconcile finds it under the same key.
        const reconciled = value<{ transactionId: string; alreadyExisted: boolean }>(
            await run("postTransaction", args, "reconcile", key),
        );
        expect(reconciled.transactionId).toBe(first.transactionId);
    });

    it("never lets Firefly invent an account from an unknown name", async () => {
        const outcome = await run("postTransaction", {
            splits: [
                {
                    type: "withdrawal",
                    date: thisMonth().start,
                    amount: "1.00",
                    description: "should be refused",
                    sourceAccount: SOURCE,
                    destinationAccount: `Hallucinated ${Date.now()}`,
                },
            ],
        });
        expect(outcome?.kind).toBe("error");
        expect((outcome as { message: string }).message).toMatch(/No account named/i);
    });
});
