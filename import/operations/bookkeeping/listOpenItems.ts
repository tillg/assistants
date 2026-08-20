// bookkeeping.listOpenItems — unpaid invoices and unclaimed reimbursements: the non-zero balances
// on payable and receivable accounts.
async function execute(args, host) {
    const accounts = await loadAccounts(host, true);
    return accounts.filter(function (a) {
        const type = String(a.type).toLowerCase();
        // `liabilit` prefix again (BUG-02): a payables account reads as `liabilities` here.
        const isOpenItemAccount =
            /payable|receivable/i.test(a.name) && (type.indexOf("liabilit") === 0 || type === "asset" || type === "debt");
        const balance = Number(a.currentBalance || "0");
        return isOpenItemAccount && Number.isFinite(balance) && Math.abs(balance) > 0.0001;
    });
}
