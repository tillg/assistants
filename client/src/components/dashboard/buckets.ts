/**
 * The month ladder behind the **createdOn curve**: a baseline before the window, then one bucket per
 * month, oldest first.
 *
 * Its whole job is the boundary convention, and the convention is load-bearing. `date_range` bounds are
 * **inclusive at both ends**, so an instant that is one bucket's `to` and the next bucket's `from` is
 * counted twice and every cumulative point after it is wrong. Each bucket therefore ends **one second**
 * before the next one starts — one second and not one millisecond, because A12's `DateTimeType` is
 * modelled `yyyy-MM-dd'T'HH:mm:ss` and a sub-second gap is a gap the stored values cannot express.
 *
 * The bounds carry **no `Z` and no offset**, matching what `nowIso` in `runtime/src/a12/things.ts`
 * writes into `CreatedAt`: a bound in a format the column does not use returns a plausible wrong count
 * rather than an error. The instants are computed in UTC for the same reason — that is what the Runtime
 * stamps. A household reading the curve near midnight in `SCHEDULE_TIMEZONE` may therefore see a Document
 * land in the neighbouring month; the curve is monthly and the discrepancy is one day at one boundary.
 *
 * The instant is a **parameter**. There is no `Date.now()` in this module, and that is what makes the
 * invariant testable.
 */

/** Twelve months, ending in the month of the instant. */
export const MONTHS = 12;

export interface MonthBucket {
    /** `m0` … `m11`, oldest first — the key its count query is asked under. */
    readonly key: string;
    /** What the chart's axis says, e.g. `Sep 2025`. */
    readonly label: string;
    /** Inclusive. */
    readonly from: string;
    /** Inclusive, and exactly one second before the next bucket's `from`. */
    readonly to: string;
}

export interface Ladder {
    /** Everything stamped before the window: an open `date_range` with only a `to`. */
    readonly before: { readonly key: "before"; readonly to: string };
    readonly months: readonly MonthBucket[];
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** `yyyy-MM-dd'T'HH:mm:ss`, in UTC — the same shape `nowIso` produces, and for the same reason. */
function stamp(utcMillis: number): string {
    return new Date(utcMillis).toISOString().replace(/\.\d{3}Z$/, "");
}

/** The first instant of the month `offset` months after the one containing `instant`. */
function monthStart(instant: Date, offset: number): number {
    return Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth() + offset, 1, 0, 0, 0);
}

/** The twelve months up to and including the one `instant` falls in, and the baseline before them. */
export function monthBuckets(instant: Date): Ladder {
    const months: MonthBucket[] = [];

    for (let i = 0; i < MONTHS; i++) {
        // Oldest first: the first bucket starts eleven months before the current one.
        const from = monthStart(instant, i - (MONTHS - 1));
        const next = monthStart(instant, i - (MONTHS - 2));
        const start = new Date(from);
        months.push({
            key: `m${i}`,
            label: `${MONTH_NAMES[start.getUTCMonth()]} ${start.getUTCFullYear()}`,
            from: stamp(from),
            to: stamp(next - 1000)
        });
    }

    return { before: { key: "before", to: stamp(monthStart(instant, -(MONTHS - 1)) - 1000) }, months };
}
