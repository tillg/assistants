/**
 * Synchronous approval-prompt renderers for Dynamic Operations.
 *
 * A Dynamic Operation runs its stored Source in a worker (ADR-0025), so it has no compiled author to
 * ask for a `describeCall`. But `renderApprovalPrompt` (advance.ts) is synchronous and must not block
 * on the worker. For the operations that move money, the JSON fallback is the exact "User clicks yes
 * without reading" outcome the approval prompt exists to prevent — so the describer lives here, keyed
 * by Operation name, as a pure synchronous function of the call arguments. The registry consults this
 * map when it resolves a Dynamic Operation.
 */

export type OperationDescriber = (args: Record<string, unknown>) => string;

/** The subset of a posting split the approval sentence reads. */
interface PostingSplitView {
    amount?: unknown;
    currencyCode?: unknown;
    sourceAccount?: unknown;
    destinationAccount?: unknown;
    date?: unknown;
    description?: unknown;
}

/** `€96.50`, or `96.50 CHF` when it is not the currency the household keeps its books in. */
function money(amount: unknown, currencyCode: unknown): string {
    const value = String(amount ?? "?");
    const currency = String(currencyCode ?? "EUR").toUpperCase();
    return currency === "EUR" ? `€${value}` : `${value} ${currency}`;
}

function describePosting(args: Record<string, unknown>): string {
    const splits = Array.isArray(args["splits"]) ? (args["splits"] as PostingSplitView[]) : [];
    // A model that emitted `splits` as a JSON string, or omitted it, gets the JSON fallback rather
    // than a confident sentence about nothing. "Book a transaction with no postings?" is a safety
    // question that describes no posting, which is worse than showing the User the raw call — the
    // call is going to be refused by `execute` either way, and the fallback exists for exactly this.
    if (splits.length === 0) return "";

    // "€96.50 from *Payables* to *Expenses:Health*, dated …, for …" — the money and the two accounts
    // are one phrase, so the commas fall where a reader would pause rather than after the verb.
    const posting = (split: PostingSplitView) =>
        [
            `${money(split.amount, split.currencyCode)} ` +
                `from *${split.sourceAccount || "(no source)"}* ` +
                `to *${split.destinationAccount || "(no destination)"}*`,
            split.date ? `dated ${split.date}` : undefined,
            split.description ? `for ${split.description}` : undefined,
        ]
            .filter(Boolean)
            .join(", ");

    if (splits.length === 1) return `Book ${posting(splits[0]!)}?`;
    // The verb goes in the question and not in every bullet, so a list of postings reads as a list.
    return [
        `Book ${splits.length} postings${args["groupTitle"] ? ` under *${String(args["groupTitle"])}*` : ""}?`,
        ``,
        ...splits.map((split) => `- ${posting(split)}`),
    ].join("\n");
}

/**
 * Describers keyed by Operation name. Only the money-moving Operations need one — everything else is
 * content the User can read in the JSON fallback without a safety cost.
 */
export const dynamicDescribers: Record<string, OperationDescriber> = {
    "bookkeeping.postTransaction": describePosting,
};
