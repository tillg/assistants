import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import type { Account } from "../../../components/dashboard/AccountsTile";
import type { ExternalCall } from "../../../components/dashboard/useExternalCall";

import { Frame } from "../conversation/harness";

/**
 * The Tile over a stubbed hook: what it *asks* is `useExternalCall`'s test, and what it *shows* is this
 * one. The fixtures carry the shapes the live Firefly answers with — a bare `"0"` beside twelve decimal
 * places — because a Tile that only survives tidy numbers is a Tile that has not been tested.
 */

const call = vi.hoisted(() => ({
    current: { state: "loading" } as ExternalCall<unknown>,
    asked: [] as { operation: string; args?: Record<string, unknown> }[]
}));

vi.mock("../../../components/dashboard/useExternalCall", () => ({
    useExternalCall: (operation: string, args?: Record<string, unknown>) => {
        call.asked.push({ operation, args });
        return call.current;
    }
}));

const { AccountsTile } = await import("../../../components/dashboard/AccountsTile");

/** The non-breaking space `Intl` puts between the number and the symbol, spelled out so a failure reads. */
const NBSP = " ";

const READ_AT = new Date("2026-08-17T14:32:07");

function ready(data: Account[]): ExternalCall<Account[]> {
    return { state: "ready", data, readAt: READ_AT };
}

const EUROS = ready([
    { name: "Checking", type: "asset", balance: "8400.00", currency: "EUR" },
    { name: "Savings", type: "asset", balance: "1234.560000000000", currency: "EUR" },
    { name: "Receivable from insurer", type: "asset", balance: "0", currency: "EUR" }
]);

const TWO_CURRENCIES = ready([
    { name: "Checking", type: "asset", balance: "8400.00", currency: "EUR" },
    { name: "Dollar account", type: "asset", balance: "96.500000000000", currency: "USD" }
]);

function renderTile(state: ExternalCall<Account[]>) {
    call.current = state;
    render(
        <Frame>
            <AccountsTile />
        </Frame>
    );
}

describe("AccountsTile", () => {
    beforeEach(() => {
        call.current = { state: "loading" };
        call.asked = [];
    });

    it("asks the Runtime for the asset accounts, and lets the Runtime know what that means", () => {
        renderTile(EUROS);

        expect(call.asked[0]).toEqual({ operation: "bookkeeping.listAccounts", args: { type: "asset" } });
    });

    it("shows one row per account, name beside balance", () => {
        renderTile(EUROS);

        const rows = screen.getAllByTestId("tile-accounts-account");
        expect(rows).toHaveLength(3);
        expect(rows[0]).toHaveTextContent(`Checking8.400,00${NBSP}€`);
        expect(rows[1]).toHaveTextContent(`Savings1.234,56${NBSP}€`);
        // A balance Firefly sends as a bare "0" is still a balance, and still rendered as money.
        expect(rows[2]).toHaveTextContent(`Receivable from insurer0,00${NBSP}€`);
    });

    it("totals the one currency below the rule", () => {
        renderTile(EUROS);

        const lines = screen.getAllByTestId("tile-accounts-total");
        expect(lines).toHaveLength(1);
        expect(lines[0]).toHaveTextContent(`Total EUR9.634,56${NBSP}€`);
    });

    it("gives two currencies two totals and never a grand total", () => {
        renderTile(TWO_CURRENCIES);

        const lines = screen.getAllByTestId("tile-accounts-total");
        expect(lines).toHaveLength(2);
        expect(lines[0]).toHaveTextContent(`Total EUR8.400,00${NBSP}€`);
        expect(lines[1]).toHaveTextContent(`Total USD96,50${NBSP}$`);
        // 8400 + 96.50 is not a number. The old assertion looked for `/8\.496/`, a string nothing could
        // have produced; what actually has to hold is that every total line names the currency it is a
        // total of, so a currency-less grand total would fail here.
        for (const line of lines) {
            expect(line.textContent).toMatch(/^Total (EUR|USD)/);
        }
    });

    it("carries no headline, because the honest one cannot be computed", () => {
        renderTile(TWO_CURRENCIES);

        expect(screen.queryByTestId("tile-accounts-headline")).not.toBeInTheDocument();
    });

    it("states the instant it read, because nothing here polls", () => {
        renderTile(EUROS);

        expect(screen.getByTestId("tile-accounts-footer")).toHaveTextContent("as of 14:32");
    });

    it("is an anchor to Firefly, opened safely in a new tab", () => {
        renderTile(EUROS);

        const anchor = screen.getByRole("link", { name: /Accounts/ });
        expect(anchor).toHaveAttribute("href", "http://localhost:8084");
        expect(anchor).toHaveAttribute("target", "_blank");
        expect(anchor).toHaveAttribute("rel", "noopener noreferrer");
    });

    it("shows nothing at all while it is loading", () => {
        renderTile({ state: "loading" });

        expect(screen.getByTestId("tile-accounts")).toHaveAttribute("data-state", "loading");
        expect(screen.queryByTestId("tile-accounts-account")).not.toBeInTheDocument();
        expect(screen.queryByTestId("tile-accounts-total")).not.toBeInTheDocument();
    });

    it("survives a row whose currency is blank, rather than blanking the whole Tile", () => {
        // `Intl.NumberFormat` throws `RangeError` on a currency that is not three letters, and there is
        // no ErrorBoundary anywhere in this application: one bad row used to take the Tile with it.
        renderTile(
            ready([
                { name: "Checking", type: "asset", balance: "8400.00", currency: "EUR" },
                { name: "Odd one", type: "asset", balance: "12.00", currency: "" }
            ])
        );

        const rows = screen.getAllByTestId("tile-accounts-account");
        expect(rows).toHaveLength(2);
        expect(rows[1]).toHaveTextContent("Odd one12,00");
    });

    it("says a total is short of a row it could not count, rather than under-reporting in silence", () => {
        renderTile(
            ready([
                { name: "Checking", type: "asset", balance: "8400.00", currency: "EUR" },
                { name: "Odd one", type: "asset", balance: "12.00", currency: "" }
            ])
        );

        expect(screen.getByTestId("tile-accounts-total")).toHaveTextContent(`Total EUR8.400,00${NBSP}€`);
        expect(screen.getByTestId("tile-accounts-partial")).toBeInTheDocument();
    });

    it("keeps two accounts of the same name as two rows, because Firefly permits the name twice", () => {
        const warned = vi.spyOn(console, "error").mockImplementation(() => {});
        renderTile(
            ready([
                { name: "Checking", type: "asset", balance: "8400.00", currency: "EUR" },
                { name: "Checking", type: "asset", balance: "12.00", currency: "EUR" }
            ])
        );

        expect(screen.getAllByTestId("tile-accounts-account")).toHaveLength(2);
        expect(warned).not.toHaveBeenCalled();
        warned.mockRestore();
    });

    it("says there are no accounts rather than showing an empty body that reads as a broken Tile", () => {
        renderTile(ready([]));

        expect(screen.getByTestId("tile-accounts-empty")).toBeInTheDocument();
    });

    it("shows nothing rather than mapping over an answer that was not a list at all", () => {
        // `useExternalCall` hands the Tile whatever the Runtime produced; a body in a shape nobody
        // promised must be *nothing to show*, not a `.map` of `undefined`.
        renderTile({ state: "ready", data: undefined as unknown as Account[], readAt: READ_AT });

        expect(screen.queryByTestId("tile-accounts-account")).not.toBeInTheDocument();
        expect(screen.getByTestId("tile-accounts-empty")).toBeInTheDocument();
    });

    it("shows no headline placeholder while loading, because it will never have a headline", () => {
        renderTile({ state: "loading" });

        expect(screen.queryByTestId("tile-accounts-headline-placeholder")).not.toBeInTheDocument();
    });

    it("says it could not read, rather than showing a zero balance it did not read", () => {
        renderTile({ state: "error" });

        expect(screen.getByTestId("tile-accounts")).toHaveAttribute("data-state", "error");
        expect(screen.getByTestId("tile-accounts-error")).toBeInTheDocument();
        expect(screen.queryByTestId("tile-accounts-total")).not.toBeInTheDocument();
    });
});
