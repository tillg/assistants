// Bookkeeping egress — shared prelude (ADR-0025).
//
// This block is prepended to every bookkeeping Operation's Source before it is stored, so each
// Operation reads as its own `execute` plus these helpers. It is the part of FireflyConnector that
// was worth keeping: the HTTP call wrapper, account name -> id resolution, the chart-of-accounts
// cache (now `host.cache`, TTL'd and invalidated by createAccount), category resolution, the 422
// field-name table, and the transaction projection. Everything it reaches is on `host`; there are
// no imports, because the Operation Host hands the Source its one capability rather than loading one.

// Firefly's own internal accounts are not part of any chart of accounts a household books to. This
// is a deny-list on purpose: an allow-list once missed that Firefly answers `liabilities` where it
// accepts `liability`, and hid the payables account (BUG-02).
const INTERNAL_ACCOUNT_TYPES = ["initial-balance", "reconciliation", "import"];
function isBookable(type) {
    return INTERNAL_ACCOUNT_TYPES.indexOf(String(type).toLowerCase()) === -1;
}

function todayIso() {
    return new Date().toISOString().slice(0, 10);
}

// One call to Firefly, through the injected client. The credential is attached by the Host and never
// seen here. A non-2xx throws with Firefly's own message where it gave one — the reader sees exactly
// the HTTP this makes. Callers that need the raw status (postTransaction) use host.http.request.
async function fireflyCall(host, method, path, options) {
    const opts = options || {};
    const response = await host.http.request({ method: method, path: path, query: opts.query, body: opts.body });
    if (!response.ok) {
        const said = response.body && response.body.message ? response.body.message : "Firefly HTTP " + response.status;
        host.error(said);
    }
    return response.body;
}

// The chart of accounts, cached per egress. `refresh` bypasses the cache the way the old connector's
// `listAccounts(true)` did; createAccount evicts the key so a freshly made account is resolvable at once.
async function loadAccounts(host, refresh) {
    if (!refresh) {
        const cached = host.cache.get("accounts");
        if (cached) return cached;
    }
    const body = await fireflyCall(host, "GET", "/api/v1/accounts", { query: { limit: 200 } });
    const rows = (body && body.data) || [];
    const accounts = rows
        .map(function (row) {
            const a = row.attributes || {};
            return {
                id: row.id,
                name: String(a.name || ""),
                type: String(a.type || ""),
                currentBalance: a.current_balance,
                currencyCode: a.currency_code,
            };
        })
        .filter(function (a) {
            return isBookable(a.type);
        });
    host.cache.set("accounts", accounts);
    return accounts;
}

function accountAmbiguous(host, name, candidates) {
    const listed = candidates
        .map(function (a) {
            return '"' + a.name + '" [' + a.type + "]";
        })
        .join(" and ");
    host.error(
        'The account name "' +
            name +
            '" is ambiguous — it matches ' +
            listed +
            ". Use the exact name as it appears in the chart of accounts.",
    );
}

// Resolve a name to an id, or fail loudly. An exact match wins outright; else a single caseless
// match; two of either is ambiguous. Cache first, then one refresh-and-retry, then a 404 naming
// every account that does exist. Never let Firefly invent an account, never guess between two.
async function resolveAccountId(host, name) {
    function pick(accounts) {
        const exact = accounts.filter(function (a) {
            return a.name === name;
        });
        if (exact.length === 1) return exact[0];
        if (exact.length > 1) accountAmbiguous(host, name, exact);
        const caseless = accounts.filter(function (a) {
            return a.name.toLowerCase() === String(name).trim().toLowerCase();
        });
        if (caseless.length === 1) return caseless[0];
        if (caseless.length > 1) accountAmbiguous(host, name, caseless);
        return undefined;
    }
    const found = pick(await loadAccounts(host, false));
    if (found) return found.id;
    const refreshed = await loadAccounts(host, true);
    const retry = pick(refreshed);
    if (retry) return retry.id;
    host.error(
        'No account named "' +
            name +
            '". Existing accounts: ' +
            refreshed
                .map(function (a) {
                    return a.name;
                })
                .join(", "),
    );
}

async function currencyOf(host, name) {
    const accounts = await loadAccounts(host, false);
    const match = accounts.filter(function (a) {
        return a.name.toLowerCase() === String(name).trim().toLowerCase();
    })[0];
    return match ? match.currencyCode : undefined;
}

async function loadCategories(host, refresh) {
    if (!refresh) {
        const cached = host.cache.get("categories");
        if (cached) return cached;
    }
    const body = await fireflyCall(host, "GET", "/api/v1/categories", { query: { limit: 200 } });
    const rows = (body && body.data) || [];
    const categories = rows.map(function (row) {
        return { id: row.id, name: String((row.attributes || {}).name || "") };
    });
    host.cache.set("categories", categories);
    return categories;
}

// Category is resolved to an id, never posted by name, so a typo cannot silently create a category.
async function resolveCategoryId(host, name) {
    function pick(categories) {
        return categories.filter(function (c) {
            return c.name.toLowerCase() === String(name).trim().toLowerCase();
        })[0];
    }
    const found = pick(await loadCategories(host, false));
    if (found) return found.id;
    const refreshed = await loadCategories(host, true);
    const retry = pick(refreshed);
    if (retry) return retry.id;
    host.error(
        'No category named "' +
            name +
            '". Existing categories: ' +
            (refreshed.length
                ? refreshed
                      .map(function (c) {
                          return c.name;
                      })
                      .join(", ")
                : "(none yet)") +
            ". Leave the category out, or ask the User to create it.",
    );
}

// Firefly names a field `source_id`; the model gave a `sourceAccount`. This maps a rejection back
// into the model's own vocabulary so a 422 reads as advice, not as Firefly's internals.
const FIREFLY_FIELD_NAMES = {
    source_id: "sourceAccount",
    source_name: "sourceAccount",
    destination_id: "destinationAccount",
    destination_name: "destinationAccount",
    budget_name: "budgetName",
    category_id: "categoryName",
    category_name: "categoryName",
    currency_code: "currencyCode",
    amount: "amount",
    date: "date",
    description: "description",
    type: "type",
    notes: "notes",
};

function describeRejection(details, splits) {
    const errors = details && details.errors;
    if (!errors || Object.keys(errors).length === 0) return undefined;
    const lines = [];
    const seen = {};
    for (const key of Object.keys(errors)) {
        const messages = errors[key];
        const match = /^transactions\.(\d+)\.(.+)$/.exec(key);
        const index = match ? Number(match[1]) : 0;
        const field = match ? match[2] : key;
        const property = FIREFLY_FIELD_NAMES[field];
        const supplied = property && splits[index] ? splits[index][property] : undefined;
        const label = property || field;
        const where = splits.length > 1 ? " (posting " + (index + 1) + ")" : "";
        const said = messages
            .join(" ")
            .replace(/ID "\d+"/g, supplied !== undefined ? '"' + String(supplied) + '"' : "that account")
            .replace(/ or name ""\.?/g, "");
        const line = label + where + (supplied === undefined ? "" : ' "' + String(supplied) + '"') + ": " + said.trim();
        if (!seen[line]) {
            seen[line] = true;
            lines.push(line);
        }
    }
    return (
        "Firefly refused this posting.\n" +
        lines
            .map(function (l) {
                return "- " + l;
            })
            .join("\n")
    );
}

// One Firefly transaction group -> one row per split, in the model's own field names.
function projectTransactionGroup(group) {
    const attributes = group.attributes || {};
    const splits = attributes.transactions || [];
    return splits.map(function (split) {
        return {
            transactionId: group.id,
            date: String(split.date || "").slice(0, 10),
            description: split.description,
            amount: split.amount,
            currency: split.currency_code,
            from: split.source_name,
            to: split.destination_name,
            category: split.category_name || undefined,
            budget: split.budget_name || undefined,
            bookedUnderKey: split.external_id || undefined,
            tags: split.tags || undefined,
        };
    });
}
