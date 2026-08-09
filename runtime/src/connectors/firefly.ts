/**
 * The Bookkeeping Connector — Firefly III over REST.
 *
 * Two decisions in here are load-bearing:
 *
 *   1. **Account names are resolved to ids, never passed through.** Firefly *auto-creates* an
 *      expense or revenue account when handed a name it does not know, so a hallucinated
 *      `Expenses:Helth` would not fail — it would succeed, silently creating a second account and
 *      corrupting a balance no test would catch. Since Bookkeeping is the Authority (ADR-0006),
 *      nothing else holds a copy to disagree with.
 *   2. **Posting is keyed.** The Runtime's idempotency key goes into `external_id`, so recovery
 *      after a crash can *ask* whether a transaction landed instead of re-posting it. The
 *      Invoice's ThingID travels separately, as a `thing:` tag and in `external_url`.
 */

import { readFileSync } from "node:fs";
import { log } from "../log.js";

export interface FireflyAccount {
    id: string;
    name: string;
    type: string;
    currentBalance?: string;
    currencyCode?: string;
}

export interface PostingSplit {
    type: "withdrawal" | "deposit" | "transfer";
    date: string;
    amount: string;
    description: string;
    currencyCode?: string;
    sourceAccount: string;
    destinationAccount: string;
    budgetName?: string;
    categoryName?: string;
    notes?: string;
}

export class FireflyError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly details?: unknown,
    ) {
        super(message);
        this.name = "FireflyError";
    }
}

export class FireflyConnector {
    private accountCache: FireflyAccount[] | undefined;
    private token: string;

    constructor(
        private readonly baseUrl: string,
        token: string,
        private readonly tokenFile: string | undefined,
        private readonly uiBaseUrl: string,
        private readonly fetchImpl: typeof fetch = fetch,
    ) {
        this.token = token;
    }

    private resolveToken(): string {
        if (this.token) return this.token;
        if (this.tokenFile) {
            try {
                this.token = readFileSync(this.tokenFile, "utf8").trim();
            } catch (error) {
                throw new FireflyError(
                    `No Firefly token available (${this.tokenFile}): ${String(error)}`,
                    0,
                );
            }
        }
        if (!this.token) throw new FireflyError("No Firefly token configured", 0);
        return this.token;
    }

    private async call<T>(
        method: string,
        path: string,
        body?: unknown,
    ): Promise<{ data: T; status: number }> {
        const response = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}/api/v1${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${this.resolveToken()}`,
                Accept: "application/json",
                "Content-Type": "application/json",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

        const text = await response.text();
        const payload: unknown = text ? safeJson(text) : undefined;

        if (!response.ok) {
            const message =
                (payload as { message?: string } | undefined)?.message ??
                `Firefly HTTP ${response.status}`;
            throw new FireflyError(message, response.status, payload);
        }
        return { data: payload as T, status: response.status };
    }

    async listAccounts(refresh = false): Promise<FireflyAccount[]> {
        if (this.accountCache && !refresh) return this.accountCache;
        const { data } = await this.call<{
            data: Array<{ id: string; attributes: Record<string, unknown> }>;
        }>("GET", "/accounts?limit=200");
        this.accountCache = (data.data ?? []).map((row) => ({
            id: row.id,
            name: String(row.attributes["name"] ?? ""),
            type: String(row.attributes["type"] ?? ""),
            currentBalance: row.attributes["current_balance"] as string | undefined,
            currencyCode: row.attributes["currency_code"] as string | undefined,
        }));
        return this.accountCache;
    }

    /** Resolve a name to an id, or fail loudly. Never let Firefly invent an account. */
    async resolveAccountId(name: string): Promise<string> {
        const accounts = await this.listAccounts();
        const exact = accounts.find((account) => account.name === name);
        if (exact) return exact.id;
        const caseless = accounts.find(
            (account) => account.name.toLowerCase() === name.trim().toLowerCase(),
        );
        if (caseless) return caseless.id;

        const refreshed = await this.listAccounts(true);
        const retry = refreshed.find(
            (account) => account.name.toLowerCase() === name.trim().toLowerCase(),
        );
        if (retry) return retry.id;

        throw new FireflyError(
            `No account named "${name}". Existing accounts: ${refreshed
                .map((account) => account.name)
                .join(", ")}`,
            404,
        );
    }

    async createAccount(input: {
        name: string;
        type: string;
        role?: string;
        currencyCode?: string;
        openingBalance?: string;
        openingBalanceDate?: string;
        liabilityType?: string;
        liabilityDirection?: string;
    }): Promise<FireflyAccount> {
        const body: Record<string, unknown> = {
            name: input.name,
            type: input.type,
            currency_code: input.currencyCode ?? "EUR",
        };
        if (input.type === "asset") body["account_role"] = input.role ?? "defaultAsset";
        if (input.type === "liability" || input.type === "liabilities") {
            // Firefly rejects a liability without these: "The liability type field is required
            // when type is liability." A household payables account is a debt we owe, carrying
            // no interest.
            body["type"] = "liability";
            body["liability_type"] = input.liabilityType ?? "debt";
            body["liability_direction"] = input.liabilityDirection ?? "credit";
            body["interest"] = "0";
            body["interest_period"] = "monthly";
            if (!input.openingBalance) {
                body["opening_balance"] = "0";
                body["opening_balance_date"] = todayIso();
            }
        }
        if (input.openingBalance) {
            body["opening_balance"] = input.openingBalance;
            body["opening_balance_date"] = input.openingBalanceDate ?? todayIso();
        }
        const { data } = await this.call<{ data: { id: string; attributes: Record<string, unknown> } }>(
            "POST",
            "/accounts",
            body,
        );
        this.accountCache = undefined;
        return {
            id: data.data.id,
            name: String(data.data.attributes["name"] ?? input.name),
            type: String(data.data.attributes["type"] ?? input.type),
        };
    }

    /** Did a transaction with this idempotency key already land? */
    async findByExternalId(externalId: string): Promise<{ id: string } | undefined> {
        const query = encodeURIComponent(`external_id_is:${externalId}`);
        const { data } = await this.call<{ data?: Array<{ id: string }> }>(
            "GET",
            `/search/transactions?query=${query}&limit=5`,
        );
        const first = data.data?.[0];
        return first ? { id: first.id } : undefined;
    }

    /**
     * Post a transaction group, keyed for idempotency.
     *
     * Returns the existing group when the key already landed, which is what makes lease recovery
     * safe: recovery asks rather than re-executes.
     */
    async postTransaction(input: {
        groupTitle?: string;
        externalId: string;
        thingId?: string;
        splits: PostingSplit[];
    }): Promise<{ id: string; alreadyExisted: boolean }> {
        const existing = await this.findByExternalId(input.externalId).catch(() => undefined);
        if (existing) {
            log.info("firefly: transaction already booked under this key", {
                externalId: input.externalId,
                id: existing.id,
            });
            return { id: existing.id, alreadyExisted: true };
        }

        const transactions = [];
        for (const split of input.splits) {
            const sourceId = await this.resolveAccountId(split.sourceAccount);
            const destinationId = await this.resolveAccountId(split.destinationAccount);
            transactions.push({
                type: split.type,
                date: split.date,
                amount: split.amount,
                description: split.description,
                currency_code: split.currencyCode ?? "EUR",
                source_id: sourceId,
                destination_id: destinationId,
                ...(split.budgetName ? { budget_name: split.budgetName } : {}),
                ...(split.categoryName ? { category_name: split.categoryName } : {}),
                ...(split.notes ? { notes: split.notes } : {}),
                external_id: input.externalId,
                ...(input.thingId
                    ? {
                          tags: [`thing:${input.thingId}`],
                          external_url: `${this.uiBaseUrl}/#/Invoice/${input.thingId}`,
                      }
                    : {}),
            });
        }

        const { data } = await this.call<{ data: { id: string } }>("POST", "/transactions", {
            ...(input.groupTitle ? { group_title: input.groupTitle } : {}),
            error_if_duplicate_hash: true,
            transactions,
        });
        return { id: data.data.id, alreadyExisted: false };
    }

    async getBalance(accountName: string): Promise<{ account: string; balance: string; currency: string }> {
        const id = await this.resolveAccountId(accountName);
        const { data } = await this.call<{ data: { attributes: Record<string, unknown> } }>(
            "GET",
            `/accounts/${id}`,
        );
        return {
            account: accountName,
            balance: String(data.data.attributes["current_balance"] ?? "0"),
            currency: String(data.data.attributes["currency_code"] ?? "EUR"),
        };
    }

    async listTransactions(input: {
        start: string;
        end: string;
        accountName?: string;
        limit?: number;
    }): Promise<Array<Record<string, unknown>>> {
        const limit = input.limit ?? 25;
        const path = input.accountName
            ? `/accounts/${await this.resolveAccountId(input.accountName)}/transactions?start=${input.start}&end=${input.end}&limit=${limit}`
            : `/transactions?start=${input.start}&end=${input.end}&limit=${limit}`;
        const { data } = await this.call<{ data?: Array<Record<string, unknown>> }>("GET", path);
        return data.data ?? [];
    }

    /**
     * Open items are non-zero balances on payable / receivable accounts — "invoice tracking falls
     * out of double entry for free", as ACCOUNTING.md puts it.
     */
    async listOpenItems(): Promise<FireflyAccount[]> {
        const accounts = await this.listAccounts(true);
        return accounts.filter((account) => {
            const isOpenItemAccount =
                /payable|receivable/i.test(account.name) &&
                (account.type === "liability" || account.type === "asset" || account.type === "debt");
            const balance = Number(account.currentBalance ?? "0");
            return isOpenItemAccount && Number.isFinite(balance) && Math.abs(balance) > 0.0001;
        });
    }

    async createBudget(name: string): Promise<{ id: string }> {
        const { data } = await this.call<{ data: { id: string } }>("POST", "/budgets", {
            name,
            active: true,
        });
        return { id: data.data.id };
    }

    async setBudgetLimit(input: {
        budgetId: string;
        start: string;
        end: string;
        amount: string;
        currencyCode?: string;
    }): Promise<void> {
        await this.call("POST", `/budgets/${input.budgetId}/limits`, {
            start: input.start,
            end: input.end,
            amount: input.amount,
            currency_code: input.currencyCode ?? "EUR",
        });
    }

    async listBudgets(): Promise<Array<{ id: string; name: string; spent?: unknown }>> {
        const { data } = await this.call<{
            data?: Array<{ id: string; attributes: Record<string, unknown> }>;
        }>("GET", "/budgets");
        return (data.data ?? []).map((row) => ({
            id: row.id,
            name: String(row.attributes["name"] ?? ""),
            spent: row.attributes["spent"],
        }));
    }

    async isReachable(): Promise<boolean> {
        try {
            const response = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}/healthcheck`);
            return response.ok;
        } catch {
            return false;
        }
    }
}

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return { message: text.slice(0, 400) };
    }
}

function todayIso(): string {
    return new Date().toISOString().slice(0, 10);
}
