import { describe, expect, it } from "vitest";

import { MONTHS, monthBuckets } from "../../../components/dashboard/buckets";

/**
 * The ladder's test is the **invariant**, not the arithmetic: no instant may fall in two buckets, and no
 * instant inside the window may fall in none. `date_range` bounds are inclusive at both ends, so a shared
 * boundary is counted twice and the whole cumulative curve is wrong from that point on.
 */

/** A fixed instant, mid-month, so nothing here depends on the day this suite runs. */
const AUGUST = new Date("2026-08-17T09:12:33Z");

/** The shape `nowIso` writes and the column therefore holds: no milliseconds, no `Z`, no offset. */
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

/** One second, in the format above — the gap the stored values can actually express. */
function oneSecondBefore(stamp: string): string {
    return shifted(stamp, -1000);
}

function oneSecondAfter(stamp: string): string {
    return shifted(stamp, 1000);
}

function shifted(stamp: string, millis: number): string {
    return new Date(Date.parse(`${stamp}Z`) + millis).toISOString().replace(/\.\d{3}Z$/, "");
}

describe("monthBuckets", () => {
    it("walks twelve months, oldest first, ending in the month of the instant", () => {
        const { months } = monthBuckets(AUGUST);

        expect(months).toHaveLength(MONTHS);
        expect(months[0]?.from).toBe("2025-09-01T00:00:00");
        expect(months[MONTHS - 1]?.from).toBe("2026-08-01T00:00:00");
        expect(months[MONTHS - 1]?.to).toBe("2026-08-31T23:59:59");
    });

    it("leaves exactly one second between one bucket and the next, and none anywhere else", () => {
        const { before, months } = monthBuckets(AUGUST);

        expect(before.to).toBe(oneSecondBefore(months[0]!.from));
        for (let i = 0; i < months.length - 1; i++) {
            expect(months[i]!.to).toBe(oneSecondBefore(months[i + 1]!.from));
        }
    });

    it("gives every bucket a start before its own end", () => {
        const { months } = monthBuckets(AUGUST);

        for (const month of months) {
            expect(Date.parse(`${month.from}Z`)).toBeLessThan(Date.parse(`${month.to}Z`));
        }
    });

    it("emits bounds in the shape the column holds — no milliseconds, no Z, no offset", () => {
        const { before, months } = monthBuckets(AUGUST);

        expect(before.to).toMatch(STAMP);
        for (const month of months) {
            expect(month.from).toMatch(STAMP);
            expect(month.to).toMatch(STAMP);
        }
    });

    it("crosses a year boundary without inventing a thirteenth month", () => {
        const { months } = monthBuckets(new Date("2026-01-09T00:00:01Z"));

        expect(months.map((m) => m.from.slice(0, 7))).toEqual([
            "2025-02",
            "2025-03",
            "2025-04",
            "2025-05",
            "2025-06",
            "2025-07",
            "2025-08",
            "2025-09",
            "2025-10",
            "2025-11",
            "2025-12",
            "2026-01"
        ]);
        expect(months[10]?.to).toBe("2025-12-31T23:59:59");
        expect(months[11]?.from).toBe("2026-01-01T00:00:00");
    });

    it("knows February in a leap year, and in the year after it", () => {
        const leap = monthBuckets(new Date("2024-02-20T12:00:00Z")).months;
        const ordinary = monthBuckets(new Date("2025-02-20T12:00:00Z")).months;

        expect(leap[MONTHS - 1]?.to).toBe("2024-02-29T23:59:59");
        expect(ordinary[MONTHS - 1]?.to).toBe("2025-02-28T23:59:59");
    });

    it("labels each month for the axis, oldest first", () => {
        const { months } = monthBuckets(AUGUST);

        expect(months[0]?.label).toBe("Sep 2025");
        expect(months[MONTHS - 1]?.label).toBe("Aug 2026");
    });

    it("keys the buckets the way the count queries name them", () => {
        const { months } = monthBuckets(AUGUST);

        expect(months.map((m) => m.key)).toEqual(Array.from({ length: MONTHS }, (_, i) => `m${i}`));
    });

    it("takes its instant as a parameter, which is what makes all of the above testable", () => {
        const first = monthBuckets(AUGUST);
        const again = monthBuckets(AUGUST);

        expect(again).toEqual(first);
    });

    it("catches every instant in the window in exactly one bucket", () => {
        const { before, months } = monthBuckets(AUGUST);
        const ladder = [{ from: "0001-01-01T00:00:00", to: before.to }, ...months];

        // Both ends of every bucket, and one second either side of each — the instants a boundary bug
        // hides in. Each must be inside exactly one bucket, because `date_range` includes both bounds.
        const bounds = months.flatMap((month) => [month.from, month.to]);
        const probes = bounds.flatMap((bound) => [bound, oneSecondBefore(bound), oneSecondAfter(bound)]);

        // One second past the last bucket's end is outside the window, and belonging to nothing is the
        // right answer there — the invariant is about instants the ladder claims to cover.
        const end = Date.parse(`${months[MONTHS - 1]!.to}Z`);

        for (const probe of probes) {
            const at = Date.parse(`${probe}Z`);
            if (at > end) {
                continue;
            }
            const hits = ladder.filter(
                (bucket) => at >= Date.parse(`${bucket.from}Z`) && at <= Date.parse(`${bucket.to}Z`)
            );
            expect(hits, `${probe} fell in ${hits.length} buckets`).toHaveLength(1);
        }
    });
});
