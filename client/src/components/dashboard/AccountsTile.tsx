import styled from "styled-components";

import { PLACE_ICONS } from "../icons";

import { BOOKKEEPING_URL } from "./BookkeepingButton";
import { DashboardTile, mutedText } from "./DashboardTile";
import { amount, totals } from "./money";
import { asOf } from "./readAt";
import { useExternalCall } from "./useExternalCall";

/**
 * What the household owns, one line per account and a total per currency.
 *
 * **The title is "Accounts", not "Bank accounts".** The Operation is asked for `type: "asset"`, and an
 * asset is not only a bank: *"Receivable from insurer"* is an asset the household genuinely holds and
 * genuinely wants counted. Naming the Tile after the bank would make every non-bank row on it look like
 * a bug, so the Tile is named after what it actually asked for.
 *
 * **The filter is an argument, not a `.filter()` here.** Firefly's own vocabulary — the literal
 * `"asset"`, and the `liability`/`liabilities` mismatch behind BUG-02 — belongs on the Connector's side
 * of the system; a component that knew it would be a second place to keep it right.
 *
 * **No headline.** The obvious candidate is the sum of the balances, and that is precisely the number
 * that cannot be honestly produced once the household holds two currencies. So the sums stay below the
 * rule, one line per currency, and the Tile carries no big figure at all — a headline that appeared and
 * vanished with the shape of the account list would be worse than none. It passes no `expectsHeadline`
 * either, so no placeholder is drawn where a number is never going to arrive.
 *
 * **What it cannot show, it says.** An empty answer is a line saying so rather than an empty body, which
 * is indistinguishable from a broken Tile; a row whose currency or balance is unusable is still listed,
 * but is left out of the totals and the Tile says the totals are short of it. A wrong number here is
 * worse than a missing one — the household would reconcile against it.
 *
 * **It is a door.** `href` rather than `onOpen`: the books are another application, and a summary is not
 * a way in — a User who reads a balance here and wants to correct it needs Firefly, not a module.
 */

/** One asset account, exactly as `bookkeeping.listAccounts` answers it. */
export interface Account {
    readonly name: string;
    readonly type: string;
    /** A raw amount, sometimes `"0"` and sometimes twelve decimal places — never parsed before `money.ts`. */
    readonly balance: string;
    readonly currency: string;
}

const Row = styled.div`
    display: flex;
    gap: 0.5rem;
    justify-content: space-between;
`;

/** The name gives way, not the number: a balance that has been ellipsised is not a balance. */
const Name = styled.span`
    /* A flex item refuses to shrink below its content unless it is told it may. */
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
`;

const Figure = styled.span`
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
`;

/** The rule is what says *below here is arithmetic* — without it a total is just another account. */
const TotalRow = styled(Row)`
    margin-top: 0.3rem;
    padding-top: 0.3rem;
    border-top: 1px solid ${({ theme }) => theme.colors.divider.color};
    font-weight: 600;
`;

/** An empty body and a broken Tile look identical, so the Tile says which of the two it is. */
const Nothing = styled.span`
    ${mutedText}
`;

/** A total short of a row is a wrong number unless it says so; it says so where it is read. */
const Caveat = styled(Nothing)`
    font-size: 0.9em;
`;

export function AccountsTile() {
    const accounts = useExternalCall<Account[]>("bookkeeping.listAccounts", { type: "asset" });

    // The hook is handed whatever the Runtime produced, and a body in a shape nobody promised is
    // *nothing to show* — a `.map` of something that is not a list would take the Dashboard down.
    const answered = accounts.state === "ready" ? accounts.data : [];
    const rows = Array.isArray(answered) ? answered : [];
    const sums = totals(rows.map((account) => ({ amount: account.balance, currency: account.currency })));
    // Every row unusable leaves no total to carry the flag, and that is the most incomplete a read can
    // be — so it is said here rather than lost between the two.
    const partial = sums.some((total) => total.partial === true) || (rows.length > 0 && sums.length === 0);

    return (
        <DashboardTile
            role="tile-accounts"
            icon={PLACE_ICONS.accounts}
            title="Accounts"
            state={accounts.state}
            body={
                accounts.state === "ready" ? (
                    <>
                        {rows.length === 0 && <Nothing data-role="tile-accounts-empty">no accounts</Nothing>}
                        {/*
                         * The index is in the key because Firefly permits two accounts of the same name,
                         * and two rows sharing a key is React dropping or duplicating one of them.
                         */}
                        {rows.map((account, index) => (
                            <Row key={`${account.name}-${index}`} data-role="tile-accounts-account">
                                <Name>{account.name}</Name>
                                <Figure>{amount(account.balance, account.currency)}</Figure>
                            </Row>
                        ))}
                        {sums.map((total) => (
                            <TotalRow key={total.currency} data-role="tile-accounts-total">
                                <Name>Total {total.currency}</Name>
                                <Figure>{amount(total.value, total.currency)}</Figure>
                            </TotalRow>
                        ))}
                        {partial && (
                            <Caveat data-role="tile-accounts-partial">
                                some accounts could not be counted; the totals are short of them
                            </Caveat>
                        )}
                    </>
                ) : undefined
            }
            footer={accounts.state === "ready" ? asOf(accounts.readAt) : undefined}
            href={BOOKKEEPING_URL}
        />
    );
}
