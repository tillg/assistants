import { useMemo } from "react";
import { format, isValid, parseISO, subDays } from "date-fns";
import styled from "styled-components";

import { CssEllipsis } from "@com.mgmtp.a12.widgets/widgets-core";

import { PLACE_ICONS } from "../icons";

import { BOOKKEEPING_URL } from "./BookkeepingButton";
import { DashboardTile, mutedText } from "./DashboardTile";
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
 * **The amounts are rendered as the books hold them, and the arrow carries the direction.** The rows
 * Firefly answers with have no `type` — only `from` and `to` — so there is no direction to read off a
 * row. Inventing one from the account names would mean teaching a component the household's chart of
 * accounts, and getting it wrong renders money coming in as money going out. `Payables →
 * Expenses:Health` already says which way it went, and says it without guessing. (`money.ts` had a
 * `signed()` for the shape Firefly does *not* send here; it had no caller and was deleted.)
 *
 * **A thin row is still a row.** A date that will not parse is shown as the string the books hold rather
 * than thrown on, an arrow with nothing either side of it is left out, and an empty window says so —
 * one unreadable booking must not blank the other nine, and there is no ErrorBoundary to catch it if
 * it does.
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
    ${mutedText}
`;

const Row = styled.div`
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
`;

const When = styled.span`
    flex: none;
    ${mutedText}
    font-variant-numeric: tabular-nums;
`;

/**
 * Truncation rather than wrapping: a description long enough to wrap would make one row two rows tall,
 * and ten bookings must occupy ten lines at every width or the Tile changes height with its contents.
 *
 * `CssEllipsis` rather than the three-rule `overflow`/`text-overflow`/`white-space` incantation this was,
 * and it brings something the incantation did not: it puts the full text in a `title` when — and only
 * when — it actually had to cut it, so a truncated description is still readable by hovering it.
 *
 * `maxLine={1}` is given rather than left to the widget, which otherwise measures its parent's height on
 * mount to decide how many lines fit. That measurement wants a parent whose height does not depend on its
 * contents, and a Tile's is precisely that: it grows with its rows. One line is the rule here anyway.
 *
 * The two flex rules stay ours: the widget knows how to clamp text, not how wide it is allowed to be.
 */
const What = styled(CssEllipsis)`
    flex: 1 1 auto;
    /* A flex item refuses to shrink below its content unless it is told it may. */
    min-width: 0;
`;

const Route = styled(CssEllipsis)`
    ${mutedText}
    flex: 0 1 auto;
    min-width: 0;
`;

const Figure = styled.span`
    flex: none;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
`;

/** An empty body and a broken Tile look identical, so the Tile says which of the two it is. */
const Nothing = styled.span`
    ${mutedText}
`;

/**
 * The day, or the string the books hold if that is not a day.
 *
 * `format(parseISO(""))` throws `RangeError: Invalid time value`, and a throw during render blanks the
 * Tile — there is no ErrorBoundary in this application. A date that cannot be read is shown as it
 * arrived: unhelpful, but true, and beside nine rows that are fine.
 */
function day(date: string): string {
    const parsed = parseISO(date ?? "");
    return isValid(parsed) ? format(parsed, "dd.MM.") : (date ?? "");
}

/**
 * The route, with the arrow only where there are two ends for it to join.
 *
 * A booking missing its `from` and `to` used to render as a bare `→` with nothing either side, which
 * reads as a rendering fault rather than as a row the books are thin on.
 */
function route(from: string, to: string): string {
    return [from, to].filter(Boolean).join(" → ");
}

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
    // And an answer that is not a list at all is *nothing to show*, not something to slice.
    const answered = bookings.state === "ready" ? bookings.data : [];
    const rows = (Array.isArray(answered) ? answered : []).slice(0, LIMIT);

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
                        {rows.length === 0 && (
                            <Nothing data-role="tile-transactions-empty">nothing booked in this window</Nothing>
                        )}
                        {/*
                         * The index is in the key because a split transaction is flattened into several
                         * rows that all carry the *same* `transactionId`, and two rows sharing a key is
                         * React dropping or duplicating one of them on the next update.
                         */}
                        {rows.map((booking, index) => (
                            <Row key={`${booking.transactionId}-${index}`} data-role="tile-transactions-booking">
                                <When>{day(booking.date)}</When>
                                <What maxLine={1}>{booking.description}</What>
                                <Route maxLine={1}>{route(booking.from, booking.to)}</Route>
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
