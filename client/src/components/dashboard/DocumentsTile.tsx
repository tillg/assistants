import { useDispatch } from "react-redux";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import styled, { useTheme } from "styled-components";

import { openModule } from "../../sagas/openModule";

import { PLACE_ICONS } from "../icons";

import { monthBuckets, type Ladder } from "./buckets";
import { DashboardTile, mutedText } from "./DashboardTile";
import { asOf } from "./readAt";
import { useThingCounts, type CountQuery } from "./useThingCounts";

/**
 * How many Documents there are, and how that number grew — the **createdOn curve**, over the last twelve
 * months. It is the one fact no overview can show: a table says what is there now, and *"six arrived
 * last month and one this month"* is the sentence that says whether the household is being fed.
 *
 * Thirteen counts build it — a baseline before the window, then one per month — and the running sum is
 * done here, in the client, because the store returns twelve independent numbers and a cumulative curve
 * is presentation.
 *
 * The curve can lag the headline, and the Tile says so rather than hiding it. `Document.CreatedAt` is the
 * **Runtime's** field, backfilled at the start of every scan, so a Document the User created while the
 * Runtime was paused counts in the unconstrained headline and in no month's bucket. That gap is the
 * **createdOn lag**: named, because a named discrepancy is a fact while an unnamed one is a bug report.
 */

const FIELD = "/Document/CreatedAt";

/** One point of the curve: a month, and how many Documents had been stamped by the end of it. */
export interface CurvePoint {
    readonly label: string;
    readonly documents: number;
}

/** The fourteen queries: one unconstrained total, one open-ended baseline, and twelve month windows. */
export function documentQueries(ladder: Ladder): CountQuery[] {
    return [
        { key: "total", model: "Document_DM" },
        {
            key: "before",
            model: "Document_DM",
            constraint: { operator: "date_range", field: FIELD, to: ladder.before.to }
        },
        ...ladder.months.map((month) => ({
            key: month.key,
            model: "Document_DM",
            constraint: { operator: "date_range", field: FIELD, from: month.from, to: month.to }
        }))
    ];
}

/** `before`, then `before + m0`, then `+ m1` … — twelve points, one per month, oldest first. */
export function documentCurve(ladder: Ladder, counts: Readonly<Record<string, number>>): CurvePoint[] {
    let running = counts["before"] ?? 0;
    return ladder.months.map((month) => {
        running += counts[month.key] ?? 0;
        return { label: month.label, documents: running };
    });
}

/**
 * How many Documents exist that the curve cannot show. Zero is the ordinary case, and zero says nothing.
 */
export function createdOnLag(total: number, curve: readonly CurvePoint[]): number {
    const last = curve[curve.length - 1]?.documents ?? 0;
    return Math.max(0, total - last);
}

const Chart = styled.div`
    width: 100%;
    /* The slot gives the Tile its width; the curve needs a height of its own or it collapses to none. */
    height: 5rem;
`;

/**
 * The named discrepancy, in the smallest size the theme offers for text meant to be read. It was
 * `0.85em` inside a `0.9em` body, which compounded to about 12px — the smallest thing on the Dashboard
 * was the sentence explaining why the number above it disagrees with the curve beside it.
 */
const Lag = styled.p`
    ${mutedText}
    font-size: ${({ theme }) => theme.typography.fontSize.smallFontSize};
`;

export function DocumentsTile() {
    const dispatch = useDispatch();
    const theme = useTheme();
    // One ladder per render is fine: `useThingCounts` keys its effect on the queries' content, and within
    // a month the ladder's content does not change.
    const ladder = monthBuckets(new Date());
    const counts = useThingCounts(documentQueries(ladder));

    const curve = counts.state === "ready" ? documentCurve(ladder, counts.counts) : [];
    const lag = counts.state === "ready" ? createdOnLag(counts.counts["total"] ?? 0, curve) : 0;
    const line = theme.colors.interaction.primaryInteractionColor;

    return (
        <DashboardTile
            role="tile-documents"
            icon={PLACE_ICONS.documents}
            title="Documents"
            state={counts.state}
            expectsHeadline
            headline={counts.state === "ready" ? counts.counts["total"] : undefined}
            body={
                counts.state === "ready" ? (
                    <>
                        <Chart data-role="tile-documents-curve">
                            <ResponsiveContainer width="100%" height="100%">
                                <AreaChart data={curve} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
                                    {/* No YAxis: twelve points, and the shape is the message. */}
                                    <XAxis dataKey="label" hide />
                                    <Tooltip />
                                    <Area dataKey="documents" stroke={line} fill={line} fillOpacity={0.2} />
                                </AreaChart>
                            </ResponsiveContainer>
                        </Chart>
                        {lag > 0 && (
                            <Lag data-role="tile-documents-lag">
                                {lag} not yet stamped by the Runtime, so not on the curve
                            </Lag>
                        )}
                    </>
                ) : undefined
            }
            footer={counts.state === "ready" ? asOf(counts.readAt) : undefined}
            onOpen={() => dispatch(openModule({ module: "Document" }))}
        />
    );
}
