import { useMemo } from "react";
import { format, parseISO, subDays } from "date-fns";
import styled from "styled-components";

import { PLACE_ICONS } from "../icons";

import { BOOKKEEPING_URL } from "./BookkeepingButton";
import { DashboardTile } from "./DashboardTile";
import { amount } from "./money";
import { asOf } from "./readAt";
import { useExternalCall } from "./useExternalCall";

/**
 * The last ten bookings, and the window they were taken from.
 *
 * **The window is stated because it is real.** `bookkeeping.listTransactions` requires a `start` and an
 * `end`, so there is no such read as *"the last ten"* — there is only *"the last ten within a window"*.
 * Ninety days is long enough that a household with any activity fills the ten rows and short enough that
 * an empty Tile means something. Saying so on the Tile is the difference between a fact and a silent
 * assumption: with no window named, ten rows ending in April would read as a broken read rather than as
 * a quiet quarter.
 *
 * **The amounts are unsigned, and the arrow carries the direction.** The rows Firefly answers with have
 * no `type` — only `from` and `to` — so `money.signed()` has nothing to be given. Inventing a direction
 * from the account names would mean teaching a component the household's chart of accounts, and getting
 * it wrong renders money coming in as money going out. `Payables → Expenses:Health` already says which
 * way it went, and says it without guessing.
 *
 * **The window is computed once per mount.** `useExternalCall` fingerprints its arguments with
 * `JSON.stringify`, so a `start` recomputed on every render would be a new fingerprint each time only on
 * the day boundary — but a fresh `new Date()` per render is a loop waiting for a millisecond-precision
 * argument to be added. The dates are pinned in a `useMemo` so the effect fires once, which is also the
 * honest reading: this Tile shows one read, taken at the instant its footer names.
 *
 * **No headline**, for the same reason the Accounts Tile has none: the only candidate is a sum across
 * whatever currencies the ten rows happen to carry, and that is not a number. And `href` rather than
 * `onOpen`, because the books are another application.
 */

/** One booking, exactly as `bookkeeping.listTransactions` answers it. Splits are already flattened. */
export interface Booking {
    readonly transactionId: string;
    /** `yyyy-mm-dd`, trimmed by the Operation. */
    readonly date: string;
    readonly description: string;
    readonly amount: string;
    readonly currency: string;
    readonly from: string;
    readonly to: string;
}

/** Long enough to fill ten rows, short enough that an empty Tile is news. */
const WINDOW_DAYS = 90;

/** What the Operation offers, and so what the Tile promises. */
const LIMIT = 10;

const Window = styled.span`
    color: ${({ theme }) => theme.colors.text.secondaryColor};
`;

const Row = styled.div`
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
`;

const When = styled.span`
    flex: none;
    color: ${({ theme }) => theme.colors.text.secondaryColor};
    font-variant-numeric: tabular-nums;
`;

/**
 * Truncation rather than wrapping: a description long enough to wrap would make one row two rows tall,
 * and ten bookings must occupy ten lines at every width or the Tile changes height with its contents.
 */
const What = styled.span`
    flex: 1 1 auto;
    /* A flex item refuses to shrink below its content unless it is told it may. */
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
`;

const Route = styled.span`
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    color: ${({ theme }) => theme.colors.text.secondaryColor};
    text-overflow: ellipsis;
    white-space: nowrap;
`;

const Figure = styled.span`
    flex: none;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
`;

export function TransactionsTile() {
    // Once per mount, never per render: an unstable argument is a re-fingerprinted effect, which is a
    // read that never settles.
    const period = useMemo(() => {
        const today = new Date();
        return { start: format(subDays(today, WINDOW_DAYS), "yyyy-MM-dd"), end: format(today, "yyyy-MM-dd") };
    }, []);

    const bookings = useExternalCall<Booking[]>("bookkeeping.listTransactions", { ...period, limit: LIMIT });

    // The Operation is asked for ten and the Tile shows ten: the cap is stated twice rather than trusted
    // once, because a Tile that quietly grew to thirty rows would push the rest of the Dashboard down.
    const rows = bookings.state === "ready" ? bookings.data.slice(0, LIMIT) : [];

    return (
        <DashboardTile
            role="tile-transactions"
            icon={PLACE_ICONS.transactions}
            title="Transactions"
            state={bookings.state}
            body={
                bookings.state === "ready" ? (
                    <>
                        <Window data-role="tile-transactions-window">
                            the last {LIMIT} bookings, past {WINDOW_DAYS} days
                        </Window>
                        {rows.map((booking) => (
                            <Row key={booking.transactionId} data-role="tile-transactions-booking">
                                <When>{format(parseISO(booking.date), "dd.MM.")}</When>
                                <What>{booking.description}</What>
                                <Route>
                                    {booking.from} → {booking.to}
                                </Route>
                                <Figure>{amount(booking.amount, booking.currency)}</Figure>
                            </Row>
                        ))}
                    </>
                ) : undefined
            }
            footer={bookings.state === "ready" ? asOf(bookings.readAt) : undefined}
            href={BOOKKEEPING_URL}
        />
    );
}
