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
        // 8400 + 96.50 is not a number, so nothing on the Tile may print it.
        expect(screen.queryByText(/8\.496/)).not.toBeInTheDocument();
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

    it("says it could not read, rather than showing a zero balance it did not read", () => {
        renderTile({ state: "error" });

        expect(screen.getByTestId("tile-accounts")).toHaveAttribute("data-state", "error");
        expect(screen.getByTestId("tile-accounts-error")).toBeInTheDocument();
        expect(screen.queryByTestId("tile-accounts-total")).not.toBeInTheDocument();
    });
});
