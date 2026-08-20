// bookkeeping.listTransactions — the register, in a date range, optionally for one account.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
async function execute(args, host) {
    for (const field of ["start", "end"]) {
        const value = String(args[field] || "");
        if (!ISO_DATE.test(value)) {
            host.error(
                "`" +
                    field +
                    '` must be a calendar date written yyyy-mm-dd, e.g. 2026-01-31 — got "' +
                    value +
                    '". Give the first and last day of the window explicitly.',
            );
        }
    }
    const limit = Math.min(200, Math.max(1, Number(args.limit || 25) || 25)); // default 25, at most 200
    const query = { start: String(args.start), end: String(args.end), limit: limit };
    let path = "/api/v1/transactions";
    if (args.account) {
        const id = await resolveAccountId(host, String(args.account));
        path = "/api/v1/accounts/" + id + "/transactions";
    }
    const body = await fireflyCall(host, "GET", path, { query: query });
    const groups = (body && body.data) || [];
    return groups.flatMap(projectTransactionGroup);
}
