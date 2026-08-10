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

/** No outbound call may hang the scan loop. */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * The account types a transaction can actually be posted to or from.
 *
 * Note the plural in `liabilities`: Firefly's *write* API takes `liability` and its *read* API
 * answers `liabilities` (the mismatch behind BUG-02), so both spellings are accepted here. Getting
 * that wrong would silently drop the payables account from the chart and from `resolveAccountId`,
 * which is a worse version of the bug it comes from — hence the assertion beside this filter's test.
 */
function isBookable(type: string): boolean {
    const normalised = type.toLowerCase();
    return (
        normalised === "asset" ||
        normalised === "expense" ||
        normalised === "revenue" ||
        normalised.startsWith("liabilit") ||
        normalised === "debt"
    );
}

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
    private categoryCache: Array<{ id: string; name: string }> | undefined;
    /** One post at a time per idempotency key — see `postTransaction`. */
    private readonly postsInFlight = new Map<string, Promise<{ id: string; alreadyExisted: boolean }>>();
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
            // Without this a service that accepts the connection and never answers wedges the
            // whole scan loop indefinitely — the heartbeat freezes and SIGTERM cannot interrupt it.
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
        this.accountCache = (data.data ?? [])
            .map((row) => ({
                id: row.id,
                name: String(row.attributes["name"] ?? ""),
                type: String(row.attributes["type"] ?? ""),
                currentBalance: row.attributes["current_balance"] as string | undefined,
                currencyCode: row.attributes["currency_code"] as string | undefined,
            }))
            // Firefly's own bookkeeping accounts are not part of a chart of accounts anyone books
            // to. `initial-balance` and `reconciliation` refuse every posting with a 422 quoting an
            // internal id and an empty name — unactionable — so offering them to a model that is
            // told to "always look here before booking" is offering it a trap.
            //
            // `resolveAccountId` and `getBalance` read this same cache, so they inherit the filter.
            .filter((account) => isBookable(account.type));
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

    /**
     * The categories that exist. Cached like the chart of accounts, and for the same reason.
     */
    async listCategories(refresh = false): Promise<Array<{ id: string; name: string }>> {
        if (this.categoryCache && !refresh) return this.categoryCache;
        const { data } = await this.call<{
            data?: Array<{ id: string; attributes: Record<string, unknown> }>;
        }>("GET", "/categories?limit=200");
        this.categoryCache = (data.data ?? []).map((row) => ({
            id: row.id,
            name: String(row.attributes["name"] ?? ""),
        }));
        return this.categoryCache;
    }

    /**
     * Resolve a category name to an id, or fail loudly.
     *
     * Exactly the same argument as `resolveAccountId`, and it was missing for the same field on the
     * same request: handed a `category_name` it does not know, Firefly **creates** the category. So a
     * typo did not fail — it quietly grew the taxonomy. `category_id` is honoured and a bogus one is
     * rejected, which is what makes resolving possible at all.
     */
    async resolveCategoryId(name: string): Promise<string> {
        const wanted = name.trim().toLowerCase();
        const found = (await this.listCategories()).find(
            (category) => category.name.toLowerCase() === wanted,
        );
        if (found) return found.id;

        const refreshed = await this.listCategories(true);
        const retry = refreshed.find((category) => category.name.toLowerCase() === wanted);
        if (retry) return retry.id;

        throw new FireflyError(
            `No category named "${name}". Existing categories: ${
                refreshed.map((category) => category.name).join(", ") || "(none yet)"
            }. Leave the category out, or ask the User to create it.`,
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

    /**
     * Did a transaction with this idempotency key already land?
     *
     * The value **must be quoted**. Firefly's search grammar is `field:value`, so our keys —
     * `<conversationId>:<entrySeq>` — split at the colon and match nothing unquoted. That silently
     * broke the whole idempotency guarantee: recovery would re-post instead of recognising the
     * work as already done, and only `error_if_duplicate_hash` stood between a crash and a second
     * booking. Verified against a live Firefly: unquoted 0 hits, quoted 1 hit.
     */
    async findByExternalId(externalId: string): Promise<{ id: string } | undefined> {
        const query = encodeURIComponent(`external_id_is:"${externalId}"`);
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
    postTransaction(input: {
        groupTitle?: string;
        externalId: string;
        thingId?: string;
        splits: PostingSplit[];
    }): Promise<{ id: string; alreadyExisted: boolean }> {
        // One post at a time per key. `postOnce` is check-then-act and Firefly puts no uniqueness
        // constraint on `external_id`, so two callers interleaved between the probe and the POST both
        // landed. Chaining them means the second one's probe runs *after* the first has finished and
        // therefore finds it. This closes the real single-replica window and nothing wider: two
        // Runtime processes would still race, which is why compose runs exactly one (ADR-0014).
        const previous = this.postsInFlight.get(input.externalId);
        const work = previous
            ? previous.then(
                  () => this.postOnce(input),
                  () => this.postOnce(input),
              )
            : this.postOnce(input);
        this.postsInFlight.set(input.externalId, work);
        // The caller still sees the rejection; this only stops the *chain* counting as unhandled.
        void work.catch(() => undefined);
        void work
            .catch(() => undefined)
            .finally(() => {
                if (this.postsInFlight.get(input.externalId) === work) {
                    this.postsInFlight.delete(input.externalId);
                }
            });
        return work;
    }

    private async postOnce(input: {
        groupTitle?: string;
        externalId: string;
        thingId?: string;
        splits: PostingSplit[];
    }): Promise<{ id: string; alreadyExisted: boolean }> {
        // Deliberately NOT `.catch(() => undefined)`. A failed probe is not evidence of absence:
        // if the search 500s or the token has just rotated, treating that as "nothing there" posts
        // a duplicate against real books, and ADR-0006 means nothing else holds a copy to
        // disagree. Let it throw — it becomes a tool error the next Turn can see.
        const existing = await this.findByExternalId(input.externalId);
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
                // The *id*, never the name: handed a name it does not know, Firefly creates the
                // category — the one thing this Connector exists to prevent, and it was doing it on
                // the same request where it carefully resolves both account names.
                ...(split.categoryName
                    ? { category_id: await this.resolveCategoryId(split.categoryName) }
                    : {}),
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

        // The same posting may already be booked under a *different* key: two Turns, or two
        // Conversations about one invoice, each mint their own. `error_if_duplicate_hash` cannot see
        // those as duplicates because `external_id` participates in the hash it compares — so the key
        // that differs is the very thing that defeats the guard. The `thing:` tag is the question the
        // connector can ask instead, and never did.
        if (input.thingId) {
            const already = await this.findSamePostingForThing(input.thingId, transactions);
            if (already) {
                log.info("firefly: this posting is already booked for this Thing", {
                    thingId: input.thingId,
                    externalId: input.externalId,
                    id: already,
                });
                return { id: already, alreadyExisted: true };
            }
        }

        const body = {
            ...(input.groupTitle ? { group_title: input.groupTitle } : {}),
            transactions,
        };
        try {
            const { data } = await this.call<{ data: { id: string } }>("POST", "/transactions", {
                ...body,
                error_if_duplicate_hash: true,
            });
            return { id: data.data.id, alreadyExisted: false };
        } catch (error) {
            const duplicateOf = duplicateHashVictim(error);
            if (duplicateOf === undefined) throw error;
            // Firefly's duplicate-hash index outlives a delete while its search does not, so a
            // journal the User removed as a correction blocks its own key for ever, with an error
            // naming a transaction that no longer exists. Retrying without the flag is safe *only*
            // once the named journal is confirmed gone — otherwise this would re-open the
            // double-booking hole the flag exists to close.
            if (await this.transactionExists(duplicateOf)) throw error;
            log.warn("firefly: re-booking over the hash of a deleted transaction", {
                externalId: input.externalId,
                deleted: duplicateOf,
            });
            const { data } = await this.call<{ data: { id: string } }>("POST", "/transactions", {
                ...body,
                error_if_duplicate_hash: false,
            });
            return { id: data.data.id, alreadyExisted: false };
        }
    }

    /**
     * Is this exact posting already booked against this Thing, under any key?
     *
     * Compared on the content — date, amount, type and both account ids — and **not** on the tag
     * alone. ACCOUNTING.md gives one invoice up to four legitimate journals (book the payable, pay it,
     * claim from the insurer, the insurer pays), all carrying the same ThingID, so "one transaction
     * per Thing" would make the payment leg a silent no-op: a worse bug than the one being fixed.
     */
    private async findSamePostingForThing(
        thingId: string,
        wanted: Array<Record<string, unknown>>,
    ): Promise<string | undefined> {
        const query = encodeURIComponent(`tag_is:"thing:${thingId}"`);
        const { data } = await this.call<{
            data?: Array<{ id: string; attributes?: { transactions?: Array<Record<string, unknown>> } }>;
        }>("GET", `/search/transactions?query=${query}&limit=25`);

        for (const group of data.data ?? []) {
            const booked = group.attributes?.transactions ?? [];
            if (booked.length !== wanted.length) continue;
            const allMatched = wanted.every((split) => booked.some((candidate) => sameSplit(split, candidate)));
            if (allMatched) return group.id;
        }
        return undefined;
    }

    /** Does that journal still exist? Firefly answers a missing one with 401, not 404 — measured. */
    private async transactionExists(id: string): Promise<boolean> {
        try {
            await this.call("GET", `/transactions/${id}`);
            return true;
        } catch (error) {
            // 401 for "gone" is Firefly's own oddity. Reading it as gone is safe here because the
            // search by `external_id` already succeeded moments earlier in this same method — a token
            // that had really stopped working would have failed there first.
            const status = error instanceof FireflyError ? error.status : 0;
            return status !== 401 && status !== 404;
        }
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
            // Firefly's *write* API takes `type: "liability"`; its *read* API answers
            // `"liabilities"`. Matching only the singular made this return an empty list while
            // thousands were owed — and the Accountant's skill says to report from this call and
            // nothing else, so it stated confidently that nothing was outstanding.
            const type = account.type.toLowerCase();
            const isOpenItemAccount =
                /payable|receivable/i.test(account.name) &&
                (type.startsWith("liabilit") || type === "asset" || type === "debt");
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

    /**
     * Budgets, with the target and the spend, for a period.
     *
     * Two calls, because Firefly puts the two numbers in two places and neither is available
     * unasked:
     *
     *   - `GET /budgets` **without** a period answers `spent: null` for every budget. With one, it
     *     answers an array of per-currency sums, and they are **negative**.
     *   - the target is not on the budget at all: it lives on its limits. `GET /budget-limits` returns
     *     every limit across every budget in one call, joinable on `budget_id` — which is why this is
     *     two requests and not 1 + N.
     *
     * `spent` comes back as a positive number and `limit` as a number or `undefined`. A budget with no
     * limit in the window gets `undefined`, not `0`: "no target set" and "a target of nothing" are
     * different answers, and a model told `0` would read an unlimited budget as a spent-out one.
     */
    async listBudgets(period: {
        start: string;
        end: string;
    }): Promise<Array<{ id: string; name: string; spent: number; limit?: number; currency?: string }>> {
        const query = `start=${period.start}&end=${period.end}`;
        const [budgets, limits] = await Promise.all([
            this.call<{ data?: Array<{ id: string; attributes: Record<string, unknown> }> }>(
                "GET",
                `/budgets?${query}`,
            ),
            this.call<{ data?: Array<{ id: string; attributes: Record<string, unknown> }> }>(
                "GET",
                `/budget-limits?${query}`,
            ),
        ]);

        const limitByBudget = new Map<string, { amount: number; currency?: string }>();
        for (const row of limits.data.data ?? []) {
            const budgetId = String(row.attributes["budget_id"] ?? "");
            const amount = Number(row.attributes["amount"] ?? NaN);
            if (!budgetId || !Number.isFinite(amount)) continue;
            // Several limits can overlap a window; the household's own reading of "the target" is
            // what is set for this period, so take the largest rather than an arbitrary one.
            const existing = limitByBudget.get(budgetId);
            if (!existing || amount > existing.amount) {
                limitByBudget.set(budgetId, {
                    amount,
                    currency: row.attributes["currency_code"] as string | undefined,
                });
            }
        }

        return (budgets.data.data ?? []).map((row) => {
            const spentRows = (row.attributes["spent"] ?? []) as Array<Record<string, unknown>>;
            const spent = Array.isArray(spentRows)
                ? spentRows.reduce((total, entry) => total + Math.abs(Number(entry["sum"] ?? 0)), 0)
                : 0;
            const limit = limitByBudget.get(row.id);
            return {
                id: row.id,
                name: String(row.attributes["name"] ?? ""),
                spent: Number(spent.toFixed(2)),
                ...(limit ? { limit: limit.amount, currency: limit.currency } : {}),
            };
        });
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

/**
 * The transaction Firefly says this one duplicates, if that is why it refused.
 *
 * The message is "Duplicate of transaction #14." and it arrives under a per-split key such as
 * `transactions.0.description`, so the index varies with the split — matched across all of them
 * rather than on one literal key.
 */
function duplicateHashVictim(error: unknown): string | undefined {
    if (!(error instanceof FireflyError) || error.status !== 422) return undefined;
    const errors = (error.details as { errors?: Record<string, string[]> } | undefined)?.errors ?? {};
    for (const messages of Object.values(errors)) {
        for (const message of messages) {
            const match = /Duplicate of transaction #(\d+)/i.exec(message);
            if (match) return match[1];
        }
    }
    const match = /Duplicate of transaction #(\d+)/i.exec(error.message);
    return match ? match[1] : undefined;
}

/** Two postings are the same posting when their money, their date and their accounts all agree. */
function sameSplit(wanted: Record<string, unknown>, booked: Record<string, unknown>): boolean {
    const amount = (value: unknown) => Number(Number(value ?? NaN).toFixed(2));
    return (
        String(booked["date"] ?? "").slice(0, 10) === String(wanted["date"] ?? "").slice(0, 10) &&
        amount(booked["amount"]) === amount(wanted["amount"]) &&
        Number.isFinite(amount(wanted["amount"])) &&
        String(booked["type"] ?? "") === String(wanted["type"] ?? "") &&
        String(booked["source_id"] ?? "") === String(wanted["source_id"] ?? "") &&
        String(booked["destination_id"] ?? "") === String(wanted["destination_id"] ?? "")
    );
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
