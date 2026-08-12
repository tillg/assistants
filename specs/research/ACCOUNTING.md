# Accounting / BookKeeping

The **BookKeeping** external system (see [README](../../README.md)) is the system our **Accountant** assistant talks to. This document describes what a simple bookkeeping system needs to provide — the core concepts and the operations — and gives a market overview of existing (open source, ideally CLI) systems we could use instead of building our own.

[TOC]

## Scope

We are doing *personal / household* bookkeeping, not corporate accounting:

* Track invoices (mostly incoming: doctor, craftsmen, …) and their life cycle (received → checked → paid → reimbursed).
* Track payments and match them to invoices.
* Track budgets (e.g. the house renovation budget) and how spending runs against them.
* Occasionally write an invoice / claim money (e.g. insurance reimbursements).

No payroll, no tax filing, no depreciation schedules. If a system offers those, fine, but they must not add complexity to our use case.

## Core concepts

A minimal but *correct* bookkeeping system is built on **double-entry accounting**. That sounds heavyweight but is actually the simplest model that stays consistent — every movement of money has a source and a destination, so nothing can silently disappear.

### Account

A named bucket that money sits in or flows through. Accounts form a tree (the **chart of accounts**), e.g.:

```
Assets:Checking            (our bank account)
Assets:Receivable:Insurance (money the insurance still owes us)
Liabilities:Payable:Doctor  (invoices we still have to pay)
Expenses:Health
Expenses:House:Renovation
Income:Reimbursements
```

Five root types: **Assets**, **Liabilities**, **Income**, **Expenses**, **Equity**. Everything else is naming convention — no configuration needed beyond creating accounts on first use.

### Transaction (journal entry)

One dated event consisting of two or more **postings** (account + amount). The amounts of all postings sum to zero — that's the whole double-entry invariant:

```
2026-08-09  Dr. Meyer, invoice 2026-117
    Expenses:Health              +184.30 EUR
    Liabilities:Payable:Doctor   -184.30 EUR
```

The full life cycle of a doctor's invoice as transactions:

1. Invoice arrives → `Expenses:Health +184.30` / `Liabilities:Payable:Doctor -184.30` (we owe money, the expense is booked).
2. We pay it → `Liabilities:Payable:Doctor +184.30` / `Assets:Checking -184.30`.
3. We claim it → `Assets:Receivable:Insurance +184.30` / `Income:Reimbursements -184.30` (or against the expense account, matter of taste).
4. Insurance pays → `Assets:Checking +184.30` / `Assets:Receivable:Insurance -184.30`.

At every point the open balance of `Liabilities:Payable:Doctor` and `Assets:Receivable:Insurance` tells us exactly what's unpaid / unclaimed. **This is the key insight: invoice tracking falls out of double entry for free** — an unpaid invoice is just a non-zero balance on a payable account.

Transactions carry **metadata**: payee, description, tags, and links to things (`thingID` of the invoice document, payment, process). The bookkeeping system doesn't store documents — the **ThingStore** does; the books only hold references.

### Ledger / Journal

The append-only list of all transactions. Corrections are new transactions (reversals), not edits — that keeps history trustworthy.

### Balance

Sum of postings of an account (and its children) up to a date. Derived, never stored authoritatively.

### Budget

A target amount per account (or account subtree) per period (or one-off, like the renovation budget). Budget tracking = comparing actual balances against targets. Some systems have first-class budgets; in the simplest systems a budget is just a report.

### Reconciliation

Matching our booked transactions against reality (bank statement lines). Postings get a cleared/pending flag; reconciliation marks them cleared. This is what keeps the books honest.

### Reports

Everything above becomes useful through a handful of queries:

* **Register** — list transactions for an account / filter (what happened?).
* **Balance report** — balances per account subtree (where does money sit? what's open?).
* **Income statement** — income vs. expenses over a period (what did we spend on health this year?).
* **Budget report** — actual vs. target.

## Operations the BookKeeping system must provide

These are the ops the **Accountant** assistant needs, in the style of the README's external-system ops:

These are the ops the **Accountant** assistant needs. The **Operation** column is the name an
Assistant declares in its `tools[]`; a row marked **deferred** is one this table asks for and the
Runtime does not yet register, with the reason given. That distinction matters: this table was read
as a specification while five of its ten rows had no Operation behind them at all, so an Assistant
could be granted a tool that did not exist, and `bookkeeping.listTransactions` — which existed on the
connector — was unreachable, leaving the Accountant unable to check its own past bookings.
`runtime/test/tools.test.ts` reads this table and fails if a non-deferred row has no Operation.

| Operation | Description |
|---|---|
| `createAccount(name)` | Add an account to the chart (may be implicit on first posting) |
| `postTransaction(date, postings[], meta)` | Book a balanced transaction; reject unbalanced ones. `meta` includes payee, tags, and thing references (invoice thingID etc.) |
| `getBalance(account, date?)` | Balance of an account (subtree) at a date |
| `listTransactions(filter)` | Register query: by account and date range. (Tag, payee and thingID filters are not exposed yet; the `thing:` tag is returned on every row, so the Assistant can filter on it itself.) |
| `listOpenItems(account)` | Unpaid invoices / unclaimed reimbursements = non-zero sub-balances on payable/receivable accounts |
| `getBudgetReport(period)` | Actual vs. budget per account |
| `reverseTransaction(txnID)` | Correct a mistake by counter-booking. **Deferred**: a mutating Operation needs an idempotency key and a `reconcile` before it may exist at all (ADR-0012), and "which transaction" is a question the Accountant cannot yet answer, since it had no register query. Now that `listTransactions` exists this is the next one to build. |
| `markCleared(postingID)` | Reconciliation against bank statements. **Deferred**: nothing produces statement lines — Bank is a Manual Connector — so there is nothing to reconcile against. |
| `importStatement(lines[])` | Take bank statement lines (from the **Bank** external system) and propose/book matching transactions. **Deferred**: same reason, and it needs the Bank connector to be real first. |
| `exportBooks(format)` | Full data out — we must never be locked in. **Deferred as an Operation, and satisfied outside one**: Firefly's own UI exports, and the books live in the stack's Postgres. No Assistant needs it, so putting it in an LLM's hands buys nothing. |

Nice to have, not required: multi-currency (see BUG-17 — a foreign-currency amount is currently
refused rather than mis-booked), invoice document generation (that's rather a Receptionist/template
job), recurring transactions.

### What the Accountant does vs. what BookKeeping does

The intelligence lives in the assistant, not in the bookkeeping system:

* **Accountant** decides *which* accounts a doctor's invoice hits, matches statement lines to open invoices, chases unpaid claims.
* **BookKeeping** only guarantees consistency (balanced transactions, correct balances) and answers queries fast.

This means the bookkeeping system can be *very* dumb — which is exactly why the CLI/plain-text tools below are attractive.

## Market overview

Two families of candidates: **CLI / plain-text accounting tools** (simplest, files as database) and **server / web applications** (heavier, but with REST APIs). Research date: 2026-08-09.

### Server / web applications

| Tool | GitHub | ~Stars | Stack | License | Double-entry | API | Deployment |
|---|---|---|---|---|---|---|---|
| [Firefly III](https://github.com/firefly-iii/firefly-iii) | firefly-iii/firefly-iii | 24k | PHP/Laravel | AGPL-3.0 | ✅ | Full REST + OpenAPI spec | 1 Docker container, SQLite ok |
| [Actual Budget](https://github.com/actualbudget/actual) | actualbudget/actual | 28k | Node/TS | MIT | ❌ (envelope budgeting) | Node lib; REST via community wrappers | 1 container, SQLite |
| [Bigcapital](https://github.com/bigcapitalhq/bigcapital) | bigcapitalhq/bigcapital | 3.8k | Node/TS | AGPL-3.0 | ✅ | REST ("headless accounting") | Compose: MariaDB + Redis |
| [Invoice Ninja](https://github.com/invoiceninja/invoiceninja) | invoiceninja/invoiceninja | 10k | PHP/Laravel | Elastic (non-OSI) | ❌ (invoicing only) | Excellent REST + SDKs | Docker + MySQL |
| [GnuCash](https://github.com/Gnucash/gnucash) | Gnucash/gnucash | 4.3k | C++/Scheme | GPL-2+ | ✅ | none (Python bindings / `piecash`) | Desktop app |
| [ERPNext](https://github.com/frappe/erpnext) | frappe/erpnext | 38k | Python/Frappe | GPL-3.0 | ✅ | Excellent REST | Heavy multi-service |
| [Odoo Community](https://github.com/odoo/odoo) | odoo/odoo | 54k | Python | LGPL-3 | ✅ | XML/JSON-RPC | Heavy, Postgres |
| [Akaunting](https://github.com/akaunting/akaunting) | akaunting/akaunting | 10k | PHP/Laravel | BSL (non-OSI) | ❌ core (paid module) | REST | Docker + MySQL |
| [LedgerSMB](https://github.com/ledgersmb/LedgerSMB) | ledgersmb/LedgerSMB | 0.6k | Perl | GPL-2 | ✅ | REST for config only, not transactions | Docker + Postgres |

Notes:

* **Firefly III** is the best fit in this family: built exactly for personal/household finance, real double-entry underneath, and the REST API (with published OpenAPI spec and personal access tokens) covers nearly everything — accounts, transactions, bills, budgets, rules. Single container.
* **Actual Budget** is the simplest to run (single container, SQLite, MIT) and very active, but it does envelope budgeting, not double-entry, and the official API is a Node library rather than a REST service. Weak on invoice/payable semantics.
* **Bigcapital** is the dark horse: real double-entry + invoices/bills + an explicitly "headless" REST API — but a heavier compose stack and smaller community.
* **Overkill:** ERPNext and Odoo have great APIs and real accounting but drag in enterprise ceremony (companies, fiscal years, multi-service deployments).
* **Avoid:** Akaunting (double-entry is paywalled, BSL license), Invoice Ninja (no general ledger, non-OSI license), LedgerSMB (API can't post transactions), SQL-Ledger (dormant since 2021), Maybe Finance (archived 2025-07), GnuCash/Frappe Books (desktop apps, no service API).

### CLI / plain-text accounting

The [plain text accounting](https://plaintextaccounting.org) family: the "database" is a human-readable journal file, the tool is a single binary that validates it and computes reports. That maps beautifully onto our architecture — the journal itself can live in the ThingStore (or a git repo), and the Accountant assistant just appends transactions and runs queries.

| Tool | GitHub | ~Stars | Language | License | Active | Machine-readable output |
|---|---|---|---|---|---|---|
| [Ledger](https://github.com/ledger/ledger) | ledger/ledger | 6.0k | C++ | BSD-3 | slow pace | CSV/XML, **no JSON** |
| [hledger](https://github.com/simonmichael/hledger) | simonmichael/hledger | 4.6k | Haskell | GPL-3.0 | ✅ very | JSON/CSV/TSV/HTML/SQL on all core reports |
| [Beancount](https://github.com/beancount/beancount) | beancount/beancount | 5.9k | Python | GPL-2.0 | ✅ | BQL queries (SQL-like) + full Python API; [Fava](https://github.com/beancount/fava) web UI |
| [Tackler](https://github.com/tackler-ng/tackler) | tackler-ng/tackler | 0.2k | Rust | Apache-2.0 | ✅ very | JSON reports, native **git-backed** journal storage |
| [Transity](https://github.com/feramhq/transity) | feramhq/transity | 0.7k | PureScript→Rust | AGPL-3.0 | ✅ small | YAML journal (trivially machine-writable), limited output |
| [zhang](https://github.com/zhang-accounting/zhang) | zhang-accounting/zhang | 0.2k | Rust | Apache-2.0 | ✅ | Beancount-compatible syntax + built-in HTTP API |
| [ledger (Go)](https://github.com/howeyc/ledger) | howeyc/ledger | 0.5k | Go | ISC | quiet | text only |
| [knut](https://github.com/sboehler/knut) | sboehler/knut | 0.1k | Go | Apache-2.0 | semi-dormant | own text format |

All of these are proper double-entry. Notes on the interesting ones:

* **hledger** — the standout for our use case. Single static binary, very actively maintained, excellent docs. The agent appends plain text to the journal, `hledger check` validates it (strictness levels catch typos and unbalanced entries), and every core report (`print`, `balance`, `register`) emits `-O json` or CSV. `hledger import` does idempotent bank-CSV ingestion with a rules system, and `hledger-web` optionally adds a JSON REST API on top of the same files.
* **Beancount + Fava** — strictest validation of the family (accounts must be explicitly opened, balance assertions built in) and a full Python API — the best choice if the surrounding tooling is Python-native. Fava adds a genuinely nice web UI. Slightly more ceremony in the file format.
* **Ledger** — the original (2003) and very mature, but no JSON output and a lax parser (typos silently create new accounts) make it the weakest of the big three for *programmatic* driving.
* **Tackler** — dark horse: strict spec-driven format, JSON reports, and the journal can be read directly from a **git ref** — audit trail for free. Tiny community though, and no CSV-import framework.
* The rest (Transity, zhang, knut, coin, abandon, abacus-rs) are too small or too young to bet on as a foundation.

### Recommendation

Requirement: besides the API for the Accountant assistant, the system must have a **UI so the user can see (and work with) the books**. With that, the favorite is **Firefly III**:

1. **Proper double-entry underneath** — the invoice life cycle from the concepts section (payables, receivables, open items) works as described; unlike Actual Budget (envelope budgeting) or Akaunting (double-entry paywalled).
2. **Complete, documented REST API** — published OpenAPI spec, personal access tokens; covers accounts, transactions, budgets, bills, rules. Every op in the table above maps onto it. Transactions support attachments, so they can carry the invoice PDF or a link back to the ThingStore thing.
3. **Mature web UI built for exactly our scope** — personal/household finance with budgets, bills, recurring transactions, reports, multi-user auth. The user works in the same books the Accountant writes.
4. **Operationally simple** — one Docker container, SQLite is fine for single-household use.

Accepted trade-off: the books live in Firefly III's database instead of a plain-text file, so we lose the diffable/git-versionable journal. Mitigated by its export functions and the API giving full data access.

Runner-up: **Beancount + Fava** (or hledger + `hledger-web`) if we ever drop the UI requirement down to "inspect what the Accountant did" — the plain-text journal is diffable, LLM-friendly and lock-in-free, and Fava is a genuinely nice viewing UI. But Fava is read-mostly (editing beyond a simple add-transaction form means touching the journal file) and has no real auth/user story, so it loses against Firefly III for a UI the user actually works in.

If pure agent-driven simplicity ever outweighs the UI: **hledger** remains the best file-based engine — `postTransaction` = append + `hledger check`, `getBalance` = `hledger balance -O json`, `listTransactions` = `hledger register -O json`, `importStatement` = `hledger import`, and the journal *is* the export.

## Budgets in Firefly III

Firefly III is the chosen Bookkeeping system, and Bookkeeping is the **Authority** for budgets (see [ADR-0006](../../docs/adr/0006-one-authority-per-fact.md)) — no Budget is a Thing. The Accountant therefore has to work with Firefly's concept of a budget, not with one of our own. What that concept is:

* A **Budget** is a spending-control device, not a classification. It applies to **withdrawals only** — income and transfers never touch a budget. This is what separates it from a **Category** (which classifies past transactions) and a **Tag**.
* A **Budget Limit** is a separate object: an amount plus a date range. Monthly is the common case; weekly, quarterly, yearly and custom ranges are all supported, and limits may differ per period (€500 in January, €400 in a normal month).
* An **Available Budget** is the overall spending capacity for a period, used to check that the individual budgets do not over-commit the period's income. It is informational only.
* An **Auto-budget** sets limits automatically: a fixed amount per period, a percentage of income, or **rollover**, where an unspent remainder is added to the next period's limit.
* Overspending is never prevented. A transaction may always be assigned to a depleted budget; Firefly only reports the overspend.

### Where this fits our scenarios, and where it does not

Firefly's budget is a **recurring cap per period**. That fits ongoing household spending well (`Expenses:Health` at a monthly limit).

It fits the **house renovation** badly. That budget is a one-off total for a multi-year project, not a per-period cap — the question is "how much of the €X is left", not "did we overspend in July". Options within Firefly: a single Budget Limit with a custom date range spanning the whole project, or a Category plus a target tracked in a report. Neither is what Firefly's budget UI is built for.

Firefly also has nowhere to put **committed but not yet booked** money — an accepted €12,000 roofer's quote, an estimate for windows not yet ordered. Its **Bills** cover *expected recurring* expenses, and **Piggy banks** cover *savings goals*; neither models a one-off commitment. Since no External System owns that fact, the ThingStore is its Authority — see the open question in [README](../../README.md).

Sources: [Budgets](https://firefly-iii-firefly-iii.mintlify.app/features/budgets), [Organizing transactions](https://docs.firefly-iii.org/explanation/data-classification/what-to-use/), [Budgets (docs)](https://docs.firefly-iii.org/explanation/financial-concepts/budgets/).
