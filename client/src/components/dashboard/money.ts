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
 * - **The sign comes from the transaction's `type`, not from the value.** Firefly sends the magnitude
 *   and says the direction separately, so `signed` is what turns `withdrawal` into a minus. Reading a
 *   sign off the value would render every booking as money coming in.
 * - **Never a total across currencies.** `totals` groups, and the tile prints one line per currency.
 *   The sum of euros and dollars is not a number; a Dashboard that prints one is inventing a rate.
 */

/** The books are kept in Germany. */
const LOCALE = "de-DE";

/**
 * U+2212, the real minus sign. `Intl` emits a hyphen-minus, which is narrower than the digits around
 * it and reads as a dash rather than as arithmetic — so every negative this module renders is
 * normalised to the same character, whether the sign came from the value or from the type.
 */
const MINUS = "−";

/** Renders a raw amount in its own currency, sign and all. */
export function amount(value: string, currency: string): string {
    return new Intl.NumberFormat(LOCALE, { style: "currency", currency }).format(Number(value)).replace("-", MINUS);
}

/**
 * Renders an amount with the direction Firefly stated separately.
 *
 * `withdrawal` is money gone and renders negative; `deposit` renders positive; `transfer` moved money
 * between the household's own accounts and so renders unsigned — a sign on it would claim the
 * household is richer or poorer than it was.
 */
export function signed(value: string, currency: string, type: string): string {
    const magnitude = amount(String(Math.abs(Number(value))), currency);
    return type === "withdrawal" ? `${MINUS}${magnitude}` : magnitude;
}

/** One row's worth of what a total is made of. */
export interface Amount {
    readonly amount: string;
    readonly currency: string;
}

/** A sum, in one currency, as a raw amount — so the caller renders it through `amount` like any other. */
export interface Total {
    readonly currency: string;
    readonly value: string;
}

/**
 * Sums by currency, in the order the currencies first appear, and never across them.
 *
 * The sum is carried in whole cents rather than in the floating-point amounts themselves: adding
 * `0.1 + 0.2` in binary is famously not `0.3`, and a balance that ends in `…99999` on screen is a
 * Dashboard that looks broken while being right.
 */
export function totals(rows: readonly Amount[]): Total[] {
    const cents = new Map<string, number>();

    for (const row of rows) {
        cents.set(row.currency, (cents.get(row.currency) ?? 0) + Math.round(Number(row.amount) * 100));
    }

    return [...cents].map(([currency, sum]) => ({ currency, value: (sum / 100).toFixed(2) }));
}
