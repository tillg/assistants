// bookkeeping.getBalance — the current balance of one account.
async function execute(args, host) {
    const accountName = String(args.account || "");
    const id = await resolveAccountId(host, accountName);
    const body = await fireflyCall(host, "GET", "/api/v1/accounts/" + id);
    const a = (body && body.data && body.data.attributes) || {};
    return {
        account: accountName,
        balance: String(a.current_balance || "0"),
        currency: String(a.currency_code || "EUR"),
    };
}
