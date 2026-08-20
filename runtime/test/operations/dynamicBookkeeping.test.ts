/**
 * The seven `bookkeeping.*` Operations, as stored Source, run through the Operation Host against a
 * local Firefly fixture (ADR-0025). This is the port's proof: the same behavior FireflyConnector
 * carried — name -> id resolution, the chart-of-accounts cache, the `liabilities`/`liability`
 * spelling (BUG-02), the ISO-date refusal and 200-row clamp, the mandatory budget period, the 422
 * translation, and `external_id` idempotency with a `reconcile` — now lives in source a reader can see.
 *
 * The seed metadata (descriptions, parameters, mutating, egress, clientReadable) is not here; it is
 * exercised by the bootstrap test. Here the Source is prelude + one Operation, exactly as it is stored.
 */

import http from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OperationHost } from "../../src/operations/dynamic/host.js";
import type { DynamicOperationConfig } from "../../src/config.js";
import type { OperationContext, OperationOutcome } from "../../src/operations/registry.js";

const DIR = new URL("../../../import/operations/bookkeeping/", import.meta.url);
const PRELUDE = readFileSync(new URL("prelude.ts", DIR), "utf8");
function source(operation: string): string {
    return PRELUDE + "\n" + readFileSync(new URL(`${operation}.ts`, DIR), "utf8");
}

// A tiny, stateful Firefly. Tests set `state` and read `requests`.
interface FireflyState {
    accounts: Array<{ id: string; name: string; type: string; current_balance?: string; currency_code?: string }>;
    transactions: Array<Record<string, unknown>>;
    categories: Array<{ id: string; name: string }>;
    budgets: Array<Record<string, unknown>>;
    budgetLimits: Array<Record<string, unknown>>;
    /** Answered to an `external_id_is:"..."` search (idempotency probe). */
    searchResult: Array<Record<string, unknown>>;
    /** Answered to a `tag_is:"thing:..."` search (findSamePostingForThing). */
    tagSearchResult: Array<Record<string, unknown>>;
    /** Status for `GET /transactions/{id}` (transactionExists): 200 = still there, 404/401 = gone. */
    txnGetStatus: number;
    postStatus: number;
    postBody: unknown;
    /** Successive POST /transactions responses, consumed in order before postStatus/postBody. */
    postQueue: Array<{ status: number; body: unknown }>;
    createdAccount: Record<string, unknown>;
}

let server: http.Server;
let port: number;
let state: FireflyState;
let requests: Array<{ method: string; url: string; body?: unknown }>;

function reset(): void {
    state = {
        accounts: [],
        transactions: [],
        categories: [],
        budgets: [],
        budgetLimits: [],
        searchResult: [],
        tagSearchResult: [],
        txnGetStatus: 200,
        postStatus: 200,
        postBody: { data: { id: "999", attributes: {} } },
        postQueue: [],
        createdAccount: { data: { id: "1000", attributes: {} } },
    };
    requests = [];
}

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const body = raw ? JSON.parse(raw) : undefined;
            requests.push({ method: req.method ?? "", url: req.url ?? "", body });
            const path = (req.url ?? "").split("?")[0] ?? "";
            const method = req.method ?? "";
            const json = (status: number, value: unknown) => {
                res.writeHead(status, { "content-type": "application/json" });
                res.end(JSON.stringify(value));
            };
            // Search and the single-transaction GET are checked before the generic `/transactions`
            // handler, or their paths would be swallowed by it — the trap the real routing avoids.
            if (method === "GET" && path === "/api/v1/search/transactions") {
                const query = new URL(req.url ?? "", "http://x").searchParams.get("query") ?? "";
                const result = query.includes("tag_is") ? state.tagSearchResult : state.searchResult;
                return json(200, { data: result });
            }
            if (method === "GET" && /^\/api\/v1\/transactions\/[^/]+$/.test(path)) {
                return json(state.txnGetStatus, state.txnGetStatus === 200 ? { data: { id: path.split("/").pop() } } : { message: "not found" });
            }
            if (method === "GET" && path === "/api/v1/accounts") return json(200, { data: state.accounts.map(wrap) });
            if (method === "GET" && /^\/api\/v1\/accounts\/[^/]+$/.test(path)) {
                const id = path.split("/").pop() ?? "";
                const found = state.accounts.find((a) => a.id === id);
                return json(200, { data: found ? wrap(found) : { id, attributes: {} } });
            }
            if (method === "GET" && /transactions$/.test(path)) return json(200, { data: state.transactions });
            if (method === "GET" && path === "/api/v1/categories") return json(200, { data: state.categories.map(wrap) });
            if (method === "GET" && path === "/api/v1/budgets") return json(200, { data: state.budgets });
            if (method === "GET" && path === "/api/v1/budget-limits") return json(200, { data: state.budgetLimits });
            if (method === "POST" && path === "/api/v1/accounts") return json(200, state.createdAccount);
            if (method === "POST" && path === "/api/v1/transactions") {
                // A queue lets a test script successive POST responses (a 422 then a 200 for the
                // duplicate-hash recovery); otherwise the single postStatus/postBody is used.
                const next = state.postQueue.shift();
                if (next) return json(next.status, next.body);
                return json(state.postStatus, state.postBody);
            }
            return json(404, { message: "no fixture for " + path });
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(reset);

function wrap(account: Record<string, unknown>): Record<string, unknown> {
    const { id, ...attributes } = account;
    return { id, attributes };
}

function makeHost(): OperationHost {
    const config: DynamicOperationConfig = {
        timeoutMs: 20_000,
        maxBodyBytes: 4 * 1024 * 1024,
        memoryMb: 128,
        cacheTtlMs: 300_000,
        egresses: { bookkeeping: { url: `http://127.0.0.1:${port}`, token: "pat" } },
    };
    return new OperationHost(config);
}

const context = { idempotencyKey: "conv:7:3" } as unknown as OperationContext;

async function run(
    host: OperationHost,
    operation: string,
    args: Record<string, unknown>,
    mode: "execute" | "reconcile" = "execute",
): Promise<OperationOutcome | undefined> {
    return host.run(host.compile(source(operation)), mode, args, context, {
        key: `bookkeeping.${operation}`,
        egress: "bookkeeping",
    });
}

describe("getBalance", () => {
    it("resolves the name, fetches the account, projects the balance", async () => {
        state.accounts = [{ id: "5", name: "Cash", type: "asset", current_balance: "184.30", currency_code: "EUR" }];
        const outcome = await run(makeHost(), "getBalance", { account: "Cash" });
        expect(outcome).toEqual({ kind: "value", value: { account: "Cash", balance: "184.30", currency: "EUR" } });
    });

    it("refuses an unknown account, naming what does exist", async () => {
        state.accounts = [{ id: "5", name: "Cash", type: "asset" }];
        const outcome = await run(makeHost(), "getBalance", { account: "Nope" });
        expect(outcome?.kind).toBe("error");
        expect((outcome as { message: string }).message).toContain("Cash");
    });
});

describe("listAccounts", () => {
    it("filters by type, matching liability against a liabilities-typed account (BUG-02)", async () => {
        state.accounts = [
            { id: "1", name: "Cash", type: "asset", current_balance: "10", currency_code: "EUR" },
            { id: "2", name: "Dr Vet (payable)", type: "liabilities", current_balance: "-96.50", currency_code: "EUR" },
            { id: "3", name: "Firefly internal", type: "reconciliation" },
        ];
        const outcome = await run(makeHost(), "listAccounts", { type: "liability" });
        expect(outcome).toEqual({
            kind: "value",
            value: [{ name: "Dr Vet (payable)", type: "liabilities", balance: "-96.50", currency: "EUR" }],
        });
    });

    it("drops Firefly's internal account types entirely", async () => {
        state.accounts = [
            { id: "1", name: "Cash", type: "asset" },
            { id: "9", name: "(initial)", type: "initial-balance" },
        ];
        const outcome = await run(makeHost(), "listAccounts", {});
        expect((outcome as { value: unknown[] }).value).toHaveLength(1);
    });
});

describe("listOpenItems", () => {
    it("keeps only non-zero payable/receivable accounts", async () => {
        state.accounts = [
            { id: "1", name: "Dr Vet (payable)", type: "liabilities", current_balance: "-96.50" },
            { id: "2", name: "Insurer (receivable)", type: "asset", current_balance: "0" },
            { id: "3", name: "Cash", type: "asset", current_balance: "500" },
        ];
        const outcome = await run(makeHost(), "listOpenItems", {});
        const names = (outcome as { value: Array<{ name: string }> }).value.map((a) => a.name);
        expect(names).toEqual(["Dr Vet (payable)"]);
    });
});

describe("listTransactions", () => {
    it("refuses a non-ISO date", async () => {
        const outcome = await run(makeHost(), "listTransactions", { start: "1 Jan", end: "2026-01-31" });
        expect(outcome?.kind).toBe("error");
        expect((outcome as { message: string }).message).toContain("yyyy-mm-dd");
    });

    it("clamps the limit to 200 and projects each split", async () => {
        state.transactions = [
            {
                id: "77",
                attributes: {
                    transactions: [
                        {
                            date: "2026-01-15T00:00:00+00:00",
                            description: "Vet",
                            amount: "96.50",
                            currency_code: "EUR",
                            source_name: "Cash",
                            destination_name: "Dr Vet (payable)",
                        },
                    ],
                },
            },
        ];
        const outcome = await run(makeHost(), "listTransactions", { start: "2026-01-01", end: "2026-01-31", limit: 9999 });
        expect(requests.at(-1)?.url).toContain("limit=200");
        expect((outcome as { value: Array<Record<string, unknown>> }).value[0]).toMatchObject({
            transactionId: "77",
            date: "2026-01-15",
            from: "Cash",
            to: "Dr Vet (payable)",
        });
    });
});

describe("getBudgetReport", () => {
    it("defaults the period, sums spent, and omits a limit when none is set", async () => {
        state.budgets = [{ id: "b1", attributes: { name: "Health", spent: [{ sum: "-30.00" }, { sum: "-12.50" }] } }];
        state.budgetLimits = [];
        const outcome = await run(makeHost(), "getBudgetReport", {});
        const url = requests.find((r) => r.url.startsWith("/api/v1/budgets"))?.url ?? "";
        expect(url).toMatch(/start=\d{4}-\d{2}-\d{2}/);
        expect((outcome as { value: unknown[] }).value).toEqual([{ id: "b1", name: "Health", spent: 42.5 }]);
    });

    it("keeps the largest limit and its currency when one is set", async () => {
        state.budgets = [{ id: "b1", attributes: { name: "Health", spent: [] } }];
        state.budgetLimits = [
            { attributes: { budget_id: "b1", amount: "100", currency_code: "EUR" } },
            { attributes: { budget_id: "b1", amount: "150", currency_code: "EUR" } },
        ];
        const outcome = await run(makeHost(), "getBudgetReport", { start: "2026-01-01", end: "2026-01-31" });
        expect((outcome as { value: unknown[] }).value).toEqual([
            { id: "b1", name: "Health", spent: 0, limit: 150, currency: "EUR" },
        ]);
    });
});

describe("createAccount", () => {
    it("returns the existing account when the name already exists, without creating", async () => {
        state.accounts = [{ id: "5", name: "Cash", type: "asset" }];
        const outcome = await run(makeHost(), "createAccount", { name: "cash", type: "asset" });
        expect((outcome as { value: { alreadyExisted: boolean } }).value.alreadyExisted).toBe(true);
        expect(requests.some((r) => r.method === "POST")).toBe(false);
    });

    it("creates a new account and evicts the cache so a later list sees it", async () => {
        const host = makeHost();
        state.createdAccount = { data: { id: "42", attributes: { name: "Dr Vet", type: "expense" } } };
        const created = await run(host, "createAccount", { name: "Dr Vet", type: "expense" });
        expect((created as { value: { id: string } }).value.id).toBe("42");
        // The next listAccounts must refetch (cache was evicted), so it sees the fixture's new state.
        state.accounts = [{ id: "42", name: "Dr Vet", type: "expense", current_balance: "0", currency_code: "EUR" }];
        const listed = await run(host, "listAccounts", {});
        expect((listed as { value: Array<{ name: string }> }).value.map((a) => a.name)).toContain("Dr Vet");
    });

    it("reconcile finds a created account, or reports the interruption", async () => {
        const host = makeHost();
        state.accounts = [{ id: "42", name: "Dr Vet", type: "expense" }];
        const found = await run(host, "createAccount", { name: "Dr Vet" }, "reconcile");
        expect((found as { value: { alreadyExisted: boolean } }).value.alreadyExisted).toBe(true);

        state.accounts = [];
        const missing = await run(makeHost(), "createAccount", { name: "Ghost" }, "reconcile");
        expect(missing?.kind).toBe("error");
    });
});

describe("postTransaction", () => {
    const split = {
        type: "withdrawal",
        date: "2026-01-15",
        amount: "96.50",
        description: "Vet invoice",
        sourceAccount: "Cash",
        destinationAccount: "Dr Vet (payable)",
    };

    beforeEach(() => {
        state.accounts = [
            { id: "1", name: "Cash", type: "asset", currency_code: "EUR" },
            { id: "2", name: "Dr Vet (payable)", type: "liabilities", currency_code: "EUR" },
        ];
    });

    it("refuses an empty splits array", async () => {
        const outcome = await run(makeHost(), "postTransaction", { splits: [] });
        expect(outcome?.kind).toBe("error");
        expect((outcome as { message: string }).message).toContain("at least one split");
    });

    it("books, attaching the external_id and the thing tag", async () => {
        state.postBody = { data: { id: "300" } };
        const outcome = await run(makeHost(), "postTransaction", { splits: [split], thingId: "abc", groupTitle: "Vet" });
        expect(outcome).toEqual({ kind: "value", value: { transactionId: "300", alreadyExisted: false } });
        const post = requests.find((r) => r.method === "POST" && r.url === "/api/v1/transactions");
        const posted = (post?.body as { transactions: Array<Record<string, unknown>>; group_title: string }).transactions[0];
        expect(posted).toMatchObject({ external_id: "conv:7:3", source_id: "1", destination_id: "2", tags: ["thing:abc"] });
        expect((post?.body as { error_if_duplicate_hash: boolean }).error_if_duplicate_hash).toBe(true);
    });

    it("is idempotent: a key that already landed returns it rather than booking again", async () => {
        state.searchResult = [{ id: "already" }];
        const outcome = await run(makeHost(), "postTransaction", { splits: [split] });
        expect(outcome).toEqual({ kind: "value", value: { transactionId: "already", alreadyExisted: true } });
        expect(requests.some((r) => r.method === "POST")).toBe(false);
    });

    it("refuses a mismatched currency rather than letting Firefly store it at the same number", async () => {
        const outcome = await run(makeHost(), "postTransaction", {
            splits: [{ ...split, currencyCode: "USD" }],
        });
        expect(outcome?.kind).toBe("error");
        expect((outcome as { message: string }).message).toContain("EUR");
    });

    it("translates a 422 into the model's own field names", async () => {
        state.postStatus = 422;
        state.postBody = {
            message: "validation failed",
            errors: { "transactions.0.source_id": ['The source ID "1" is not a valid account.'] },
        };
        const outcome = await run(makeHost(), "postTransaction", { splits: [split] });
        expect(outcome?.kind).toBe("error");
        const message = (outcome as { message: string }).message;
        expect(message).toContain("sourceAccount");
        expect(message).toContain("Cash"); // the id was rewritten to the name the model gave
    });

    it("reconcile finds a posting under the key, or reports the interruption", async () => {
        state.searchResult = [{ id: "500" }];
        const found = await run(makeHost(), "postTransaction", { splits: [split] }, "reconcile");
        expect(found).toEqual({ kind: "value", value: { transactionId: "500", alreadyExisted: true } });

        state.searchResult = [];
        const missing = await run(makeHost(), "postTransaction", { splits: [split] }, "reconcile");
        expect(missing?.kind).toBe("error");
    });

    it("recognises the same posting already booked for the Thing under a different key", async () => {
        // external_id misses (different Turn, different key), but the thing: tag search finds a
        // content-matching journal — so it is a no-op, not a second booking of the same invoice.
        state.searchResult = []; // external_id probe misses
        state.tagSearchResult = [
            {
                id: "already-booked",
                attributes: {
                    transactions: [
                        {
                            date: "2026-01-15",
                            amount: "96.50",
                            type: "withdrawal",
                            source_id: "1", // Cash
                            destination_id: "2", // Dr Vet (payable)
                        },
                    ],
                },
            },
        ];
        const outcome = await run(makeHost(), "postTransaction", { splits: [split], thingId: "inv-9" });
        expect(outcome).toEqual({ kind: "value", value: { transactionId: "already-booked", alreadyExisted: true } });
        expect(requests.some((r) => r.method === "POST")).toBe(false);
    });

    it("re-books over the hash of a transaction the User deleted, but not over a live one", async () => {
        // Firefly's duplicate-hash index outlives a delete; the search does not. A corrected journal
        // must be re-bookable, once the named victim is confirmed gone — never over a live one.
        state.postQueue = [
            { status: 422, body: { message: "validation failed", errors: { "transactions.0.description": ["Duplicate of transaction #55."] } } },
            { status: 200, body: { data: { id: "re-booked" } } },
        ];
        state.txnGetStatus = 404; // #55 is gone
        const outcome = await run(makeHost(), "postTransaction", { splits: [split] });
        expect(outcome).toEqual({ kind: "value", value: { transactionId: "re-booked", alreadyExisted: false } });

        // The other direction: the victim still exists, so the duplicate stands as an error.
        state.postQueue = [
            { status: 422, body: { message: "validation failed", errors: { "transactions.0.description": ["Duplicate of transaction #55."] } } },
        ];
        state.txnGetStatus = 200; // #55 is live
        const refused = await run(makeHost(), "postTransaction", { splits: [split] });
        expect(refused?.kind).toBe("error");
    });
});
