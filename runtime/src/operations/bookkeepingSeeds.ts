/**
 * The seven `bookkeeping.*` Operations as Dynamic Operation seeds (ADR-0025).
 *
 * These are *seed carriers*, not registered Implementations: their Source lives on the Operation
 * Thing and is run by the Operation Host, so they must never be registered in the OperationRegistry
 * (a dynamic Thing that is also registered in code is dropped as `ambiguous`). Bootstrap alone reads
 * them, to create the Things a fresh install needs; an installed stack is switched over by the
 * migration instead. Each `execute` throws, because bootstrap never runs one and nothing else holds these.
 *
 * The Source is the shared prelude prepended to each Operation's file, loaded from
 * `import/operations/bookkeeping/` — the same text a reader sees in the web application.
 */

import { readFileSync } from "node:fs";
import type { OperationImplementation, OperationOutcome } from "./registry.js";

const DIR = new URL("../../../import/operations/bookkeeping/", import.meta.url);

function source(operation: string): string {
    const prelude = readFileSync(new URL("prelude.ts", DIR), "utf8");
    return prelude + "\n" + readFileSync(new URL(`${operation}.ts`, DIR), "utf8");
}

const str = (description: string) => ({ type: "string", description });

interface BookkeepingSeed {
    key: string;
    mutating: boolean;
    requiresApproval?: boolean;
    clientReadable?: boolean;
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

/**
 * `clientReadable` is set only on `listAccounts` and `listTransactions` — the two the Dashboard
 * reads through the inbound door — because those are the only two on the deployment allowlist. The
 * others (getBalance included, which was `clientReadable` in code but never allowlisted) leave it
 * unset, which the inbound gate reads as not client-readable.
 */
const SEEDS: BookkeepingSeed[] = [
    {
        key: "getBalance",
        mutating: false,
        name: "Account balance",
        description: "The current balance of one account.",
        parameters: {
            type: "object",
            properties: { account: str("Exact account name.") },
            required: ["account"],
        },
    },
    {
        key: "listAccounts",
        mutating: false,
        clientReadable: true,
        name: "List accounts",
        description:
            "List the chart of accounts. Always look here before booking — account names must match " +
            "exactly, and you may not invent one. Pass `type` to see only one kind: 'asset' is the money " +
            "the household holds, 'expense' and 'revenue' are the other side of a booking, and " +
            "'liabilities' — plural — covers payables and receivables.",
        parameters: {
            type: "object",
            properties: {
                type: str("Optional: only accounts of this Firefly type. asset | expense | revenue | liabilities."),
            },
        },
    },
    {
        key: "listOpenItems",
        mutating: false,
        name: "List open items",
        description:
            "Unpaid invoices and unclaimed reimbursements — the non-zero balances on payable and " +
            "receivable accounts.",
        parameters: { type: "object", properties: {} },
    },
    {
        key: "listTransactions",
        mutating: false,
        clientReadable: true,
        name: "List transactions",
        description:
            "The register: transactions in a date range, optionally for one account. Use this to check " +
            "what has already been booked before booking something again.",
        parameters: {
            type: "object",
            properties: {
                start: str("First day to include, yyyy-mm-dd."),
                end: str("Last day to include, yyyy-mm-dd. Must be after start."),
                account: str("Optional: restrict to one account, by its exact name."),
                limit: { type: "number", description: "Maximum transactions (default 25, at most 200)." },
            },
            required: ["start", "end"],
        },
    },
    {
        key: "getBudgetReport",
        mutating: false,
        name: "Budget report",
        description:
            "Each budget's target and what has been spent against it, for a period. Defaults to the " +
            "current calendar month. A budget with no target set for the period reports no limit, which " +
            "is not the same as a target of zero.",
        parameters: {
            type: "object",
            properties: {
                start: str("First day of the period, yyyy-mm-dd. Defaults to the 1st of this month."),
                end: str("Last day of the period, yyyy-mm-dd. Defaults to the end of this month."),
            },
        },
    },
    {
        key: "createAccount",
        mutating: true,
        name: "Create an account",
        description: "Add an account to the chart of accounts.",
        parameters: {
            type: "object",
            properties: {
                name: str("The account name."),
                type: str("asset | expense | revenue | liability."),
                currencyCode: str("Default EUR."),
            },
            required: ["name", "type"],
        },
    },
    {
        key: "postTransaction",
        mutating: true,
        requiresApproval: true,
        name: "Book a transaction",
        description:
            "Book a balanced transaction into the books. Account names must already exist — call " +
            "bookkeeping.listAccounts first. Safe to retry: booking the same thing twice is a no-op. The " +
            "User must approve the exact posting before it happens: the first call is refused and asks " +
            "them, and you are resumed to make the same call again once they have said yes.",
        parameters: {
            type: "object",
            properties: {
                groupTitle: str("A short title for the whole transaction."),
                thingId: str(
                    "The ThingID of the Invoice this books. Always supply it: it links the journal back to " +
                        "the Invoice, and it is the only way a repeat of this posting can be recognised — the " +
                        "idempotency key differs between Turns, so it cannot.",
                ),
                splits: {
                    type: "array",
                    description: "The postings. Usually one.",
                    items: {
                        type: "object",
                        properties: {
                            type: { type: "string", enum: ["withdrawal", "deposit", "transfer"] },
                            date: str("yyyy-mm-dd"),
                            amount: str('A positive decimal, e.g. "184.30".'),
                            description: str("What this posting is."),
                            sourceAccount: str("Exact name of the account money leaves."),
                            destinationAccount: str("Exact name of the account money arrives at."),
                            currencyCode: str(
                                "The amount's currency, if it is not the account's own. A posting in another " +
                                    "currency is refused rather than booked at the same number — convert it first, " +
                                    "or ask the User.",
                            ),
                            budgetName: str("Optional budget to charge."),
                            categoryName: str("Optional category."),
                            notes: str("Optional notes."),
                        },
                        required: ["type", "date", "amount", "description", "sourceAccount", "destinationAccount"],
                    },
                },
            },
            required: ["splits"],
        },
    },
];

/** Load the seven Dynamic Operation seeds, reading each Source from disk. Bootstrap only. */
export function loadBookkeepingSeeds(): OperationImplementation[] {
    return SEEDS.map((seed) => ({
        name: `bookkeeping.${seed.key}`,
        mutating: seed.mutating,
        async execute(): Promise<OperationOutcome> {
            throw new Error(
                `bookkeeping.${seed.key} is a Dynamic Operation, run by the Operation Host, not this seed carrier.`,
            );
        },
        seed: {
            name: seed.name,
            system: "Bookkeeping",
            kind: "connector",
            description: seed.description,
            parameters: seed.parameters,
            ...(seed.requiresApproval ? { requiresApproval: true } : {}),
            implementation: "dynamic",
            source: source(seed.key),
            language: "typescript",
            egress: "bookkeeping",
            ...(seed.clientReadable ? { clientReadable: true } : {}),
        },
    }));
}
