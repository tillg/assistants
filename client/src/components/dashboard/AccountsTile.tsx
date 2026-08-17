import styled from "styled-components";

import { PLACE_ICONS } from "../icons";

import { BOOKKEEPING_URL } from "./BookkeepingButton";
import { DashboardTile } from "./DashboardTile";
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
 * vanished with the shape of the account list would be worse than none.
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

export function AccountsTile() {
    const accounts = useExternalCall<Account[]>("bookkeeping.listAccounts", { type: "asset" });

    const rows = accounts.state === "ready" ? accounts.data : [];
    const sums = totals(rows.map((account) => ({ amount: account.balance, currency: account.currency })));

    return (
        <DashboardTile
            role="tile-accounts"
            icon={PLACE_ICONS.accounts}
            title="Accounts"
            state={accounts.state}
            body={
                accounts.state === "ready" ? (
                    <>
                        {rows.map((account) => (
                            <Row key={account.name} data-role="tile-accounts-account">
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
                    </>
                ) : undefined
            }
            footer={accounts.state === "ready" ? asOf(accounts.readAt) : undefined}
            href={BOOKKEEPING_URL}
        />
    );
}
