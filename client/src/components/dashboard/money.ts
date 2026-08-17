/**
 * The one way this application renders an amount.
 *
 * One module rather than a helper per Tile, because two Tiles show money and they must show it the
 * same way — and because every decision below is a decision about the *books*, not about a component.
 *
 * - **The locale is fixed to `de-DE`.** Not the browser's, not the User's: the books are kept in
 *   Germany, so `1.234,56 €` is what the ledger says and what a bank statement beside the screen says.
 *   A German household reading its own accounts in `en-US` grouping would be reading a translation.
 * - **The currency is never assumed.** It comes from the row, because the household has accounts in
 *   more than one and a euro sign on a dollar balance is a lie that costs nothing to avoid.
 * - **Amounts arrive as strings with twelve decimal places** — measured, not guessed:
 *   `"96.500000000000"` is what Firefly answers. They stay strings all the way here so nothing between
 *   the Connector and the screen can round them, and the only arithmetic in this file is the
 *   per-currency total, which is computed for display and discarded with the component.
 * - **Nothing here signs an amount.** The rows this application receives carry no `type`, only a `from`
 *   and a `to`, so there is no direction to read: the value is rendered exactly as the books hold it and
 *   the arrow on the Transactions Tile says which way it went. A `signed()` helper existed here with
 *   four tests and no caller, which read as covered behaviour for a case the data never presents; it was
 *   deleted rather than kept warm for a shape Firefly does not send.
 * - **Never a total across currencies.** `totals` groups, and the tile prints one line per currency.
 *   The sum of euros and dollars is not a number; a Dashboard that prints one is inventing a rate.
 * - **Neither function throws, and neither invents a zero.** A blank currency is a `RangeError` out of
 *   `Intl` and there is no ErrorBoundary in this application, so one bad row would blank a whole Tile;
 *   and `Number("")` is `0`, so a missing balance would be rendered as *you have nothing*, in a currency
 *   symbol's authoritative voice. Both are worse than showing less, so both are handled here.
 */

/** The books are kept in Germany. */
const LOCALE = "de-DE";

/**
 * U+2212, the real minus sign. `Intl` emits a hyphen-minus, which is narrower than the digits around
 * it and reads as a dash rather than as arithmetic — so every negative this module renders is
 * normalised to the same character, whether the sign came from the value or from the type.
 */
const MINUS = "−";

/**
 * What `Intl` will accept as a currency: three letters, and nothing else. `XYZ` is not a currency it has
 * heard of and is still formatted — the household may hold one — but `""`, `"EURO"` and `undefined` are
 * a `RangeError` and a `TypeError` respectively, thrown during render.
 */
const CURRENCY = /^[A-Za-z]{3}$/;

/** What is shown where a number should have been: not a number we were given, and not a zero either. */
const NOT_A_NUMBER = "—";

/** The row's own space between figure and code, so a fallback sits where `Intl`'s own symbol would. */
const NBSP = " ";

/** `undefined`, `null`, `""` and `"abc"` are all *no amount*; only a finite number is an amount. */
function parse(value: string | null | undefined): number {
    if (value === null || value === undefined || String(value).trim() === "") {
        return Number.NaN;
    }
    return Number(value);
}

/**
 * Renders a raw amount in its own currency, sign and all.
 *
 * A currency `Intl` refuses is rendered as a plain German-grouped decimal with the raw code after it —
 * `1.234,56 XX` — because a number the household can read beside an unfamiliar code is still true,
 * whereas a throw here takes the whole Tile with it.
 */
export function amount(value: string | null | undefined, currency: string | null | undefined): string {
    const parsed = parse(value);
    if (!Number.isFinite(parsed)) {
        return NOT_A_NUMBER;
    }

    if (typeof currency === "string" && CURRENCY.test(currency)) {
        return new Intl.NumberFormat(LOCALE, { style: "currency", currency }).format(parsed).replace("-", MINUS);
    }

    const decimal = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        .format(parsed)
        .replace("-", MINUS);
    const code = (currency ?? "").trim();
    return code === "" ? decimal : `${decimal}${NBSP}${code}`;
}

/** One row's worth of what a total is made of. */
export interface Amount {
    readonly amount: string | null | undefined;
    readonly currency: string | null | undefined;
}

/** A sum, in one currency, as a raw amount — so the caller renders it through `amount` like any other. */
export interface Total {
    readonly currency: string;
    readonly value: string;
    /**
     * Set when at least one row was left out of the sums, so a Tile can say the figure is short of
     * something. A total quietly missing a row is a wrong number, and a wrong number is worse than no
     * number: the household would reconcile against it. Absent rather than `false` when nothing was
     * dropped, so the ordinary total stays the ordinary shape.
     */
    readonly partial?: true;
}

/**
 * Sums by currency, in the order the currencies first appear, and never across them.
 *
 * The sum is carried in whole cents rather than in the floating-point amounts themselves: adding
 * `0.1 + 0.2` in binary is famously not `0.3`, and a balance that ends in `…99999` on screen is a
 * Dashboard that looks broken while being right.
 *
 * A row with no usable currency and a row with no usable amount are both left out rather than folded in:
 * grouping on a missing code merged unrelated accounts under a currency that was not one, and a single
 * `"abc"` turned a whole currency's total into `NaN`. Every row left out is reported through `partial`.
 */
export function totals(rows: readonly Amount[]): Total[] {
    const cents = new Map<string, number>();
    let skipped = false;

    for (const row of rows) {
        const value = parse(row.amount);
        const currency = typeof row.currency === "string" ? row.currency.trim().toUpperCase() : "";
        // `EUR` and `eur` are one currency and must be one line; the key is normalised rather than the
        // row, so what is displayed is still what Firefly said.
        if (!CURRENCY.test(currency) || !Number.isFinite(value)) {
            skipped = true;
            continue;
        }
        cents.set(currency, (cents.get(currency) ?? 0) + Math.round(value * 100));
    }

    return [...cents].map(([currency, sum]) => ({
        currency,
        value: (sum / 100).toFixed(2),
        ...(skipped ? { partial: true as const } : {})
    }));
}
