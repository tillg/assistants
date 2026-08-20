/**
 * An in-process Firefly, over HTTP, for the dynamic bookkeeping Operations (ADR-0025).
 *
 * The seven `bookkeeping.*` Operations are now stored source run by the Operation Host against an
 * HTTP egress, so the tests that used to lean on `FakeFirefly`'s method surface now need a real
 * Firefly REST endpoint to talk to. This is that endpoint: a small emulator of the handful of routes
 * the source hits, backed by mutable state the tests inspect (`posted`, `failNextPost`, `accounts`),
 * seeded to match the old `FakeFirefly` so the assertions carry over.
 *
 * It is the same "one layer out" move the integration test makes — the tests now exercise the actual
 * compiled source, the worker, the injected HTTP client and `external_id` idempotency, not a stand-in.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FireflyAccountRow {
    id: string;
    name: string;
    type: string;
    currentBalance?: string;
    currencyCode?: string;
}

/** A recorded posting, as the tests read it: `posted.length`, `posted[0].amount`, `.externalId`. */
export interface PostedTransaction {
    id: string;
    externalId: string;
    amount: string;
}

/** A next-post failure, matching FireflyError's shape (status + a `details.errors` body). */
export interface PostFailure {
    status: number;
    message: string;
    details?: { errors?: Record<string, string[]> };
}

const SEED_ACCOUNTS: FireflyAccountRow[] = [
    { id: "1", name: "Checking", type: "asset", currentBalance: "8400.00", currencyCode: "EUR" },
    { id: "2", name: "Payables", type: "liabilities", currentBalance: "-340.00", currencyCode: "EUR" },
    { id: "3", name: "Expenses:Health", type: "expense", currentBalance: "0.00", currencyCode: "EUR" },
];

const SEED_TRANSACTIONS: Array<Record<string, unknown>> = [
    {
        id: "163",
        attributes: {
            transactions: [
                {
                    type: "withdrawal",
                    date: "2026-08-01T00:00:00+02:00",
                    amount: "96.500000000000",
                    description: "Consultation and dressing change, 24 July",
                    currency_code: "EUR",
                    source_name: "Payables",
                    destination_name: "Expenses:Health",
                },
            ],
        },
    },
    {
        id: "142",
        attributes: {
            transactions: [
                {
                    type: "withdrawal",
                    date: "2026-07-02T00:00:00+02:00",
                    amount: "84.200000000000",
                    description: "Stadtwerke Frechen",
                    currency_code: "EUR",
                    source_name: "Checking",
                    destination_name: "Expenses:Utilities",
                },
                {
                    type: "deposit",
                    date: "2026-07-02T00:00:00+02:00",
                    amount: "12.000000000000",
                    description: "Stadtwerke refund",
                    currency_code: "EUR",
                    source_name: "Expenses:Utilities",
                    destination_name: "Checking",
                },
            ],
        },
    },
];

export class FireflyFixture {
    private server?: http.Server;
    url = "";

    accounts: FireflyAccountRow[] = [];
    transactions: Array<Record<string, unknown>> = [];
    categories: Array<{ id: string; name: string }> = [];
    budgets: Array<Record<string, unknown>> = [];
    budgetLimits: Array<Record<string, unknown>> = [];
    readonly posted: PostedTransaction[] = [];
    /** Set by a test to make the next POST /transactions fail the way Firefly does. */
    failNextPost: PostFailure | Error | undefined;
    /** When true, every route answers 500 — a Firefly that is down. */
    down = false;

    constructor() {
        this.reset();
    }

    /** Back to the seed state, between tests. Keeps the same array references the harness handed out. */
    reset(): void {
        this.accounts = SEED_ACCOUNTS.map((a) => ({ ...a }));
        this.transactions = SEED_TRANSACTIONS.map((t) => ({ ...t }));
        this.categories = [];
        this.budgets = [{ id: "1", attributes: { name: "Health", spent: [] } }];
        this.budgetLimits = [{ attributes: { budget_id: "1", amount: "300", currency_code: "EUR" } }];
        this.posted.length = 0;
        this.failNextPost = undefined;
        this.down = false;
    }

    async start(): Promise<void> {
        this.server = http.createServer((req, res) => this.handle(req, res));
        await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
        this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    }

    async stop(): Promise<void> {
        if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }

    private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
            const path = (req.url ?? "").split("?")[0] ?? "";
            const method = req.method ?? "";
            const send = (status: number, value: unknown) => {
                res.writeHead(status, { "content-type": "application/json" });
                res.end(JSON.stringify(value));
            };
            if (this.down) return send(500, { message: "firefly is unreachable" });

            if (method === "GET" && path === "/api/v1/search/transactions") {
                const query = new URL(req.url ?? "", "http://x").searchParams.get("query") ?? "";
                const match = /external_id_is:"([^"]*)"/.exec(query);
                const externalId = match ? match[1] : "";
                const found = this.posted.find((p) => p.externalId === externalId);
                return send(200, { data: found ? [{ id: found.id }] : [] });
            }
            if (method === "GET" && path === "/api/v1/accounts") {
                return send(200, { data: this.accounts.map((a) => this.wrapAccount(a)) });
            }
            if (method === "GET" && /^\/api\/v1\/accounts\/[^/]+$/.test(path)) {
                const id = path.split("/").pop() ?? "";
                const found = this.accounts.find((a) => a.id === id);
                return send(200, { data: found ? this.wrapAccount(found) : { id, attributes: {} } });
            }
            if (method === "GET" && /transactions$/.test(path)) return send(200, { data: this.transactions });
            if (method === "GET" && path === "/api/v1/categories") return send(200, { data: this.categories });
            if (method === "GET" && path === "/api/v1/budgets") return send(200, { data: this.budgets });
            if (method === "GET" && path === "/api/v1/budget-limits") return send(200, { data: this.budgetLimits });
            if (method === "POST" && path === "/api/v1/accounts") return this.createAccount(body, send);
            if (method === "POST" && path === "/api/v1/transactions") return this.postTransaction(body, send);
            return send(404, { message: "no fixture route for " + method + " " + path });
        });
    }

    private wrapAccount(a: FireflyAccountRow): Record<string, unknown> {
        return {
            id: a.id,
            attributes: { name: a.name, type: a.type, current_balance: a.currentBalance, currency_code: a.currencyCode },
        };
    }

    private createAccount(
        body: Record<string, unknown> | undefined,
        send: (status: number, value: unknown) => void,
    ): void {
        const name = String(body?.["name"] ?? "");
        const type = String(body?.["type"] ?? "expense");
        const created: FireflyAccountRow = {
            id: String(this.accounts.length + 1),
            name,
            type,
            currentBalance: "0.00",
            currencyCode: "EUR",
        };
        this.accounts.push(created);
        send(200, this.wrapAccount(created));
    }

    private postTransaction(
        body: Record<string, unknown> | undefined,
        send: (status: number, value: unknown) => void,
    ): void {
        if (this.failNextPost) {
            const failure = this.failNextPost;
            this.failNextPost = undefined;
            const status = "status" in failure && typeof failure.status === "number" ? failure.status : 422;
            const details = "details" in failure ? failure.details : undefined;
            return send(status, { message: failure.message, ...(details ?? {}) });
        }
        const transactions = (body?.["transactions"] ?? []) as Array<Record<string, unknown>>;
        const first = transactions[0] ?? {};
        const id = `txn-${this.posted.length + 1}`;
        this.posted.push({
            id,
            externalId: String(first["external_id"] ?? ""),
            amount: String(first["amount"] ?? "0"),
        });
        send(200, { data: { id } });
    }
}
