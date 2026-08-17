import { describe, expect, it } from "vitest";

import { amount, signed, totals } from "../../../components/dashboard/money";

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

describe("signed", () => {
    it("renders a withdrawal negative, though Firefly sent it unsigned", () => {
        expect(signed("84.200000000000", "EUR", "withdrawal")).toBe(`${MINUS}84,20${NBSP}€`);
    });

    it("renders a deposit positive", () => {
        expect(signed("96.500000000000", "EUR", "deposit")).toBe(`96,50${NBSP}€`);
    });

    it("leaves a transfer unsigned, because it left no money anywhere", () => {
        expect(signed("96.500000000000", "EUR", "transfer")).toBe(`96,50${NBSP}€`);
    });

    it("takes the direction from the type and never from the value's own sign", () => {
        // Firefly is documented to send amounts unsigned, but a `-` in the value must not flip a
        // withdrawal into a deposit if it ever does.
        expect(signed("-84.2", "EUR", "withdrawal")).toBe(`${MINUS}84,20${NBSP}€`);
        expect(signed("-84.2", "EUR", "deposit")).toBe(`84,20${NBSP}€`);
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

    it("hands back a value the renderer can read straight back", () => {
        const [total] = totals([{ amount: "1234567.890000000000", currency: "EUR" }]);

        expect(total).toBeDefined();
        expect(amount(total?.value ?? "", total?.currency ?? "")).toBe(`1.234.567,89${NBSP}€`);
    });
});
