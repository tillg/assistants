import { describe, expect, it } from "vitest";

import { amount, totals } from "../../../components/dashboard/money";

/**
 * The fixtures are the shapes the live Firefly actually answers with, not tidy ones: twelve decimal
 * places, an unsigned amount with the direction in `type`, and two currencies in one household.
 */

/** The non-breaking space `Intl` puts between the number and the symbol, spelled out so a failure reads. */
const NBSP = " ";

/** The real minus sign, U+2212 — a hyphen is not a minus, and a balance sheet is where that shows. */
const MINUS = "−";

describe("amount", () => {
    it("renders the twelve decimal places Firefly sends as two", () => {
        expect(amount("96.500000000000", "EUR")).toBe(`96,50${NBSP}€`);
        expect(amount("84.200000000000", "EUR")).toBe(`84,20${NBSP}€`);
    });

    it("groups thousands the German way, because the books are kept in Germany", () => {
        expect(amount("1234567.890000000000", "EUR")).toBe(`1.234.567,89${NBSP}€`);
    });

    it("renders a negative with a real minus sign", () => {
        expect(amount("-84.2", "EUR")).toBe(`${MINUS}84,20${NBSP}€`);
    });

    it("renders the currency it is given and never assumes the euro", () => {
        expect(amount("96.500000000000", "USD")).toBe(`96,50${NBSP}$`);
        expect(amount("96.500000000000", "CHF")).toBe(`96,50${NBSP}CHF`);
    });
});

describe("amount, given what a real answer sometimes carries", () => {
    /** `Intl` throws on a code that is not three letters, and a throw here blanks the whole Tile. */
    it("renders the number and the raw code rather than throwing on a currency Intl refuses", () => {
        expect(amount("1234.56", "")).toBe("1.234,56");
        expect(amount("1234.56", "EURO")).toBe(`1.234,56${NBSP}EURO`);
        expect(amount("1234.56", undefined)).toBe("1.234,56");
    });

    it("still renders a three-letter code Intl has never heard of, because that is a currency too", () => {
        expect(amount("96.500000000000", "XYZ")).toBe(`96,50${NBSP}XYZ`);
    });

    /**
     * `Number("")` and `Number(null)` are `0`, so the pre-fix module rendered *no data* as
     * `0,00 €` — a balance the household does not have, stated with a currency symbol's authority.
     */
    it("says it was given no number rather than printing a zero it did not read", () => {
        expect(amount("", "EUR")).toBe("—");
        expect(amount(null, "EUR")).toBe("—");
        expect(amount(undefined, "EUR")).toBe("—");
        expect(amount("abc", "EUR")).toBe("—");
    });
});

describe("totals", () => {
    it("sums one currency", () => {
        expect(
            totals([
                { amount: "96.500000000000", currency: "EUR" },
                { amount: "84.200000000000", currency: "EUR" }
            ])
        ).toEqual([{ currency: "EUR", value: "180.70" }]);
    });

    it("returns one line per currency and never a grand total", () => {
        const result = totals([
            { amount: "96.500000000000", currency: "EUR" },
            { amount: "10.000000000000", currency: "USD" },
            { amount: "84.200000000000", currency: "EUR" }
        ]);

        expect(result).toHaveLength(2);
        expect(result).toEqual([
            { currency: "EUR", value: "180.70" },
            { currency: "USD", value: "10.00" }
        ]);
    });

    it("subtracts what is negative rather than adding its magnitude", () => {
        expect(
            totals([
                { amount: "96.500000000000", currency: "EUR" },
                { amount: "-84.2", currency: "EUR" }
            ])
        ).toEqual([{ currency: "EUR", value: "12.30" }]);
    });

    it("has nothing to say about nothing", () => {
        expect(totals([])).toEqual([]);
    });

    it("counts EUR and eur as one currency, because they are one currency", () => {
        expect(
            totals([
                { amount: "96.50", currency: "EUR" },
                { amount: "84.20", currency: "eur" }
            ])
        ).toEqual([{ currency: "EUR", value: "180.70" }]);
    });

    it("leaves out a row whose currency is not a currency, and says the total is short of one", () => {
        // Two such rows grouped together used to become a single line with no currency at all, which
        // then took the render down in `amount`.
        expect(
            totals([
                { amount: "96.50", currency: "EUR" },
                { amount: "84.20", currency: undefined },
                { amount: "10.00", currency: "" }
            ])
        ).toEqual([{ currency: "EUR", value: "96.50", partial: true }]);
    });

    it("leaves out an amount that is not a number, rather than reporting the currency as NaN", () => {
        expect(
            totals([
                { amount: "96.50", currency: "EUR" },
                { amount: "abc", currency: "EUR" },
                { amount: "", currency: "EUR" }
            ])
        ).toEqual([{ currency: "EUR", value: "96.50", partial: true }]);
    });

    it("says nothing about being partial when nothing was left out", () => {
        expect(totals([{ amount: "96.50", currency: "EUR" }])).toEqual([{ currency: "EUR", value: "96.50" }]);
    });

    it("hands back a value the renderer can read straight back", () => {
        const [total] = totals([{ amount: "1234567.890000000000", currency: "EUR" }]);

        expect(total).toBeDefined();
        expect(amount(total?.value ?? "", total?.currency ?? "")).toBe(`1.234.567,89${NBSP}€`);
    });
});
