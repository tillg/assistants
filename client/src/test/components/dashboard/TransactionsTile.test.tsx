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

    it("renders the amount unsigned even when Firefly sends it negative, arrow and all", () => {
        // The old version of this test used a positive fixture, so nothing it asserted could ever fail.
        // A negative amount is the case that separates *rendered as given* from *signed by the Tile*:
        // the row is shown exactly as the books hold it, and the arrow says which way it went.
        renderTile(ready([booking(1, { amount: "-96.500000000000" })]));

        const row = screen.getByTestId("tile-transactions-booking");
        expect(row).toHaveTextContent(`−96,50${NBSP}€`);
        expect(row).toHaveTextContent("Payables → Expenses:Health");
    });

    it("renders a date it cannot parse as the raw string, rather than crashing the Tile", () => {
        // `parseISO("")` is an Invalid Date and `format` throws `RangeError` on one; with no
        // ErrorBoundary anywhere in this application that throw blanks the Tile.
        for (const date of ["", null as unknown as string, "2026-08-32"]) {
            const { unmount } = renderTile(ready([booking(1, { date })]));

            expect(screen.getByTestId("tile-transactions-booking")).toHaveTextContent(
                "Consultation and dressing change, 24 July"
            );
            unmount();
        }
    });

    it("renders both halves of a split, which share one transaction id", () => {
        const warned = vi.spyOn(console, "error").mockImplementation(() => {});
        renderTile(
            ready([
                booking(1, { description: "Rent", amount: "700.00" }),
                booking(1, { description: "Service charge", amount: "120.00" })
            ])
        );

        expect(screen.getAllByTestId("tile-transactions-booking")).toHaveLength(2);
        expect(warned).not.toHaveBeenCalled();
        warned.mockRestore();
    });

    it("leaves out the arrow when there is nothing on either side of it", () => {
        renderTile(ready([booking(1, { from: "", to: "", description: "" })]));

        expect(screen.getByTestId("tile-transactions-booking")).not.toHaveTextContent("→");
    });

    it("drops the arrow when only one side is known, and still shows the side it has", () => {
        renderTile(ready([booking(1, { from: "", to: "Expenses:Health" })]));

        const row = screen.getByTestId("tile-transactions-booking");
        expect(row).toHaveTextContent("Expenses:Health");
        expect(row).not.toHaveTextContent("→");
    });

    it("says nothing was booked in the window rather than showing an empty body", () => {
        renderTile(ready([]));

        expect(screen.getByTestId("tile-transactions-empty")).toBeInTheDocument();
    });

    it("shows nothing rather than slicing an answer that was not a list at all", () => {
        renderTile({ state: "ready", data: undefined as unknown as Booking[], readAt: READ_AT });

        expect(screen.queryByTestId("tile-transactions-booking")).not.toBeInTheDocument();
        expect(screen.getByTestId("tile-transactions-empty")).toBeInTheDocument();
    });

    it("shows no headline placeholder while loading, because it will never have a headline", () => {
        renderTile({ state: "loading" });

        expect(screen.queryByTestId("tile-transactions-headline-placeholder")).not.toBeInTheDocument();
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
