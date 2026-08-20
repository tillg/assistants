// bookkeeping.listAccounts — the chart of accounts, optionally filtered by Firefly type.
async function execute(args, host) {
    const accounts = await loadAccounts(host, true); // always fresh, as the connector did
    const wanted = String(args.type || "").trim().toLowerCase();
    function matches(accountType) {
        const t = String(accountType).toLowerCase();
        // BUG-02: Firefly's read API answers `liabilities` where its write API accepts `liability`.
        // Matching on the shared `liabilit` prefix is what makes the payables account visible here.
        return wanted === "" || t === wanted || (t.indexOf("liabilit") === 0 && wanted.indexOf("liabilit") === 0);
    }
    return accounts
        .filter(function (a) {
            return matches(a.type);
        })
        .map(function (a) {
            return { name: a.name, type: a.type, balance: a.currentBalance, currency: a.currencyCode };
        });
}
