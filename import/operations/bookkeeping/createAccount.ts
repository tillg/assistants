// bookkeeping.createAccount — add an account to the chart of accounts. Search-then-create, so a
// repeat is a no-op; the reconcile answers "did it land?" after an interrupted Turn.
async function execute(args, host) {
    const name = String(args.name || "");
    const accounts = await loadAccounts(host, true);
    const existing = accounts.filter(function (a) {
        return a.name.toLowerCase() === name.trim().toLowerCase();
    })[0];
    if (existing) return Object.assign({}, existing, { alreadyExisted: true });

    const type = String(args.type || "expense");
    const body = { name: name, type: type, currency_code: args.currencyCode ? String(args.currencyCode) : "EUR" };
    if (type === "asset") {
        body.account_role = "defaultAsset";
    }
    if (type === "liability" || type === "liabilities") {
        body.type = "liability";
        body.liability_type = "debt";
        body.liability_direction = "credit";
        body.interest = "0";
        body.interest_period = "monthly";
        body.opening_balance = "0";
        body.opening_balance_date = todayIso();
    }

    const created = await fireflyCall(host, "POST", "/api/v1/accounts", { body: body });
    // Evict the chart of accounts so the next listAccounts / resolveAccountId sees the new account
    // at once, rather than waiting out host.cache's TTL. This is what the old accountCache = undefined did.
    host.cache.delete("accounts");
    const a = (created && created.data && created.data.attributes) || {};
    return { id: created.data.id, name: String(a.name || name), type: String(a.type || type) };
}

async function reconcile(args, host) {
    const name = String(args.name || "");
    const accounts = await loadAccounts(host, true);
    const existing = accounts.filter(function (a) {
        return a.name.toLowerCase() === name.trim().toLowerCase();
    })[0];
    if (existing) return Object.assign({}, existing, { alreadyExisted: true });
    host.error('This call was interrupted; no account named "' + name + '" exists.');
}
