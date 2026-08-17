import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import type { Booking } from "../../../components/dashboard/TransactionsTile";
import type { ExternalCall } from "../../../components/dashboard/useExternalCall";

import { Frame } from "../conversation/harness";

/**
 * The Tile over a stubbed hook. The fixtures are the rows the live Firefly answers with: twelve decimal
 * places, a `from`/`to` pair, and **no `type`** — the absence this Tile's unsigned amounts are about.
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

const { TransactionsTile } = await import("../../../components/dashboard/TransactionsTile");

/** The non-breaking space `Intl` puts between the number and the symbol, spelled out so a failure reads. */
const NBSP = " ";

const READ_AT = new Date("2026-08-17T14:32:07");

function booking(id: number, overrides: Partial<Booking> = {}): Booking {
    return {
        transactionId: String(id),
        date: "2026-08-01",
        description: "Consultation and dressing change, 24 July",
        amount: "96.500000000000",
        currency: "EUR",
        from: "Payables",
        to: "Expenses:Health",
        ...overrides
    };
}

function ready(data: Booking[]): ExternalCall<Booking[]> {
    return { state: "ready", data, readAt: READ_AT };
}

function renderTile(state: ExternalCall<Booking[]>) {
    call.current = state;
    return render(
        <Frame>
            <TransactionsTile />
        </Frame>
    );
}

describe("TransactionsTile", () => {
    beforeEach(() => {
        call.current = { state: "loading" };
        call.asked = [];
    });

    it("asks for ten bookings in a ninety-day window ending today", () => {
        renderTile(ready([booking(1)]));

        const args = call.asked[0]!.args as { start: string; end: string; limit: number };
        expect(call.asked[0]!.operation).toBe("bookkeeping.listTransactions");
        expect(args.limit).toBe(10);
        expect(args.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(args.end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(Math.round((Date.parse(args.end) - Date.parse(args.start)) / 86_400_000)).toBe(90);
    });

    it("asks with the same window on every render, or the read would never settle", () => {
        const { rerender } = renderTile(ready([booking(1)]));

        rerender(
            <Frame>
                <TransactionsTile />
            </Frame>
        );

        expect(call.asked.length).toBeGreaterThan(1);
        expect(new Set(call.asked.map((ask) => JSON.stringify(ask))).size).toBe(1);
    });

    it("says which window it read, because 'the last ten' is not what it asked for", () => {
        renderTile(ready([booking(1)]));

        expect(screen.getByTestId("tile-transactions-window")).toHaveTextContent("the last 10 bookings, past 90 days");
    });

    it("shows the date, the description, the direction and the amount", () => {
        renderTile(ready([booking(1)]));

        const row = screen.getByTestId("tile-transactions-booking");
        expect(row).toHaveTextContent("01.08.");
        expect(row).toHaveTextContent("Consultation and dressing change, 24 July");
        expect(row).toHaveTextContent("Payables → Expenses:Health");
        expect(row).toHaveTextContent(`96,50${NBSP}€`);
    });

    it("renders the amount unsigned, because the row carries no direction of its own", () => {
        renderTile(ready([booking(1)]));

        // The arrow says which way it went; a minus here would be a guess about the chart of accounts.
        expect(screen.getByTestId("tile-transactions-booking")).not.toHaveTextContent("−");
    });

    it("renders each row in its own currency and never totals them", () => {
        renderTile(ready([booking(1), booking(2, { currency: "USD" })]));

        const rows = screen.getAllByTestId("tile-transactions-booking");
        expect(rows[0]).toHaveTextContent(`96,50${NBSP}€`);
        expect(rows[1]).toHaveTextContent(`96,50${NBSP}$`);
        expect(screen.queryByTestId("tile-transactions-total")).not.toBeInTheDocument();
    });

    it("shows ten rows even if the Operation ever answers with more", () => {
        renderTile(ready(Array.from({ length: 12 }, (_, index) => booking(index + 1))));

        expect(screen.getAllByTestId("tile-transactions-booking")).toHaveLength(10);
    });

    it("carries no headline, because the honest one cannot be computed", () => {
        renderTile(ready([booking(1)]));

        expect(screen.queryByTestId("tile-transactions-headline")).not.toBeInTheDocument();
    });

    it("states the instant it read, because nothing here polls", () => {
        renderTile(ready([booking(1)]));

        expect(screen.getByTestId("tile-transactions-footer")).toHaveTextContent("as of 14:32");
    });

    it("is an anchor to Firefly, opened safely in a new tab", () => {
        renderTile(ready([booking(1)]));

        const anchor = screen.getByRole("link", { name: /Transactions/ });
        expect(anchor).toHaveAttribute("href", "http://localhost:8084");
        expect(anchor).toHaveAttribute("target", "_blank");
        expect(anchor).toHaveAttribute("rel", "noopener noreferrer");
    });

    it("shows no rows at all while it is loading", () => {
        renderTile({ state: "loading" });

        expect(screen.getByTestId("tile-transactions")).toHaveAttribute("data-state", "loading");
        expect(screen.queryByTestId("tile-transactions-booking")).not.toBeInTheDocument();
    });

    it("says it could not read, rather than showing an empty ledger it did not read", () => {
        renderTile({ state: "error" });

        expect(screen.getByTestId("tile-transactions")).toHaveAttribute("data-state", "error");
        expect(screen.getByTestId("tile-transactions-error")).toBeInTheDocument();
        expect(screen.queryByTestId("tile-transactions-window")).not.toBeInTheDocument();
    });
});
