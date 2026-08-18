# 18 — demo bookings carry no budget → the budget report shows €0 spent

**Severity:** MEDIUM · **Area:** runtime/demo · **Files:** `runtime/src/demo/cli.ts` (transaction
build), `runtime/src/demo/data.ts` (budgets), cf. `runtime/src/connectors/firefly.ts` (`budget_name`)

## Failure scenario
After `just demo-data`, ask the Accountant about the renovation budget
(`bookkeeping.getBudgetReport`). It reports the budget's full amount **available and €0 spent**, even
though the renovation invoice (gross 2380.00, dated inside the budget window) was booked to
`Expenses:House:Renovation`. In Firefly a budget's "spent" is computed only from transactions carrying
that budget — booking to the expense *account* does nothing for the budget report. The demo's own
narrative (`data.ts`: "booked to the renovation account so the budget report stays honest") is
contradicted, and the Accountant's budget-checking skill demo produces misleading numbers.

## Root cause
The demo builds each split with no `budgetName`, though the connector supports `budget_name`.
(Compounding: the Health budget window `2026-08-01…2026-08-31` does not cover the demo's health invoice
dates in 2026-05/06.)

## Fix
Pass `budgetName` on the demo splits so budgeted spend lands in its budget (e.g. renovation invoices →
`Renovation`, health invoices → `Health`), and widen the Health budget window to cover the demo's health
invoice dates so its report is non-zero.

## Verification
Manual: `just demo-data` then `getBudgetReport` shows non-zero spent for Renovation (and Health). No
automated Firefly test in unit scope; validated by the connector already mapping `budgetName`→
`budget_name` and the demo dates falling in-window.
