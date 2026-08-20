// bookkeeping.getBudgetReport — each budget's target and what has been spent, for a period.
// The period is mandatory to Firefly: without it every budget reports spent: null, which reads as
// "nothing spent". Defaults to the current calendar month, first to last day (Firefly rejects
// start === end).
function currentMonth() {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    return {
        start: new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10),
        end: new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10),
    };
}
async function execute(args, host) {
    const month = currentMonth();
    const start = args.start ? String(args.start) : month.start;
    const end = args.end ? String(args.end) : month.end;
    const query = { start: start, end: end };

    const budgetsBody = await fireflyCall(host, "GET", "/api/v1/budgets", { query: query });
    const limitsBody = await fireflyCall(host, "GET", "/api/v1/budget-limits", { query: query });

    const limitByBudget = {};
    for (const row of (limitsBody && limitsBody.data) || []) {
        const a = row.attributes || {};
        const budgetId = a.budget_id;
        const amount = Number(a.amount);
        if (!budgetId || !Number.isFinite(amount)) continue;
        const current = limitByBudget[budgetId];
        if (!current || amount > current.amount) limitByBudget[budgetId] = { amount: amount, currency: a.currency_code };
    }

    return ((budgetsBody && budgetsBody.data) || []).map(function (row) {
        const a = row.attributes || {};
        const spentArray = Array.isArray(a.spent) ? a.spent : [];
        let spent = 0;
        for (const entry of spentArray) spent += Math.abs(Number(entry.sum));
        spent = Number(spent.toFixed(2));
        const limit = limitByBudget[row.id];
        const out = { id: row.id, name: String(a.name || ""), spent: spent };
        // A budget with no target for the period reports no limit, which is not a target of zero.
        if (limit) {
            out.limit = limit.amount;
            out.currency = limit.currency;
        }
        return out;
    });
}
