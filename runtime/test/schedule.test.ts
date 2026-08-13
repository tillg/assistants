/**
 * The two daylight-saving cases ADR-0016 exists for, and the plain ones around them.
 *
 * Written first, because they are the reason the wrapper is a wrapper: everything else about a cron
 * expression is arithmetic somebody else has already got right, and these two are the decisions.
 *
 * Europe/Berlin in 2026: the clocks go forward on **29 March** (02:00 → 03:00, so there is no 02:30)
 * and back on **25 October** (03:00 → 02:00, so 02:30 happens twice).
 */

import { describe, expect, it } from "vitest";
import { describeInstant, InvalidCronError, latestDueInstantBefore } from "../src/watcher/schedule.js";

const BERLIN = "Europe/Berlin";
const at = (iso: string) => new Date(iso);

describe("latestDueInstantBefore", () => {
    it("is already due the moment a Schedule is configured, because a cron has no start date", () => {
        // The plan asked for a "never yet due" case, and there is not one: a five-field cron
        // describes an infinite series in both directions, so *every* expression has a previous
        // occurrence. `undefined` remains the defensive branch for a `prev()` that cannot answer, and
        // it is unreachable for a bare expression.
        //
        // The consequence is worth an assertion of its own, because it is a surprise: a Schedule
        // configured this afternoon fires for **this morning's** slot on the very next scan. That is
        // ADR-0016's reading of what a Schedule is — a standing instruction about the current state
        // of the world, so looking now is exactly right — but it means adding a cron to an Assistant
        // has an immediate effect.
        const yearly = latestDueInstantBefore(at("2025-12-31T12:00:00Z"), "0 9 1 1 *", BERLIN);
        expect(yearly).toBe("2025-01-01T08:00:00");
    });

    it("resolves a normal daily slot to the instant it was due in local time", () => {
        // 07:00 Berlin in August is 05:00 UTC (CEST, UTC+2).
        expect(latestDueInstantBefore(at("2026-08-13T10:00:00Z"), "0 7 * * *", BERLIN)).toBe(
            "2026-08-13T05:00:00",
        );
        // In January it is 06:00 UTC (CET, UTC+1) — the same wall clock, a different instant.
        expect(latestDueInstantBefore(at("2026-01-13T10:00:00Z"), "0 7 * * *", BERLIN)).toBe(
            "2026-01-13T06:00:00",
        );
    });

    it("returns only the latest due instant, so a missed run is caught up once", () => {
        // Three days of downtime, asked on the fourth. Saturday and Sunday are never mentioned.
        expect(latestDueInstantBefore(at("2026-08-13T10:00:00Z"), "0 7 * * *", BERLIN)).toBe(
            "2026-08-13T05:00:00",
        );
    });

    it("does not fire for the spring slot that does not exist", () => {
        // 29 March 2026 has no 02:30 in Berlin at all. Asked at midday on the 29th, the latest due
        // instant is the *28th's* 02:30 — the missing hour resolves to nothing.
        expect(latestDueInstantBefore(at("2026-03-29T12:00:00Z"), "30 2 * * *", BERLIN)).toBe(
            "2026-03-28T01:30:00",
        );
        // And on the 30th it is the 30th's, so the schedule is not stuck — only that slot was skipped.
        expect(latestDueInstantBefore(at("2026-03-30T12:00:00Z"), "30 2 * * *", BERLIN)).toBe(
            "2026-03-30T00:30:00",
        );
    });

    it("gives the autumn slot that happens twice a single identity", () => {
        // 02:30 local occurs at 00:30Z (CEST) and again at 01:30Z (CET) on 25 October 2026. Whenever
        // it is asked during or after the doubled hour, the answer is the SAME instant — so the
        // second occurrence recomputes to a slot that has already been served and nothing is born.
        const first = latestDueInstantBefore(at("2026-10-25T01:00:00Z"), "30 2 * * *", BERLIN);
        const during = latestDueInstantBefore(at("2026-10-25T01:45:00Z"), "30 2 * * *", BERLIN);
        const after = latestDueInstantBefore(at("2026-10-25T12:00:00Z"), "30 2 * * *", BERLIN);

        expect(first).toBe("2026-10-25T00:30:00");
        expect(during).toBe(first);
        expect(after).toBe(first);

        // The next day is its own slot again, so collapsing does not swallow anything.
        expect(latestDueInstantBefore(at("2026-10-26T12:00:00Z"), "30 2 * * *", BERLIN)).toBe(
            "2026-10-26T01:30:00",
        );
    });

    it("does not collapse slots that merely follow one another", () => {
        // The guard against the collapse rule over-reaching: an every-minute cron has a different
        // wall clock on every step, so it walks back exactly once.
        expect(latestDueInstantBefore(at("2026-08-13T10:00:30Z"), "* * * * *", BERLIN)).toBe(
            "2026-08-13T10:00:00",
        );
    });

    it("throws rather than reporting 'never due' for an expression that does not parse", () => {
        // The distinction that matters: a misconfigured Schedule has to be *sayable*, because
        // silently never firing is the same symptom as working perfectly with nothing to do.
        expect(() => latestDueInstantBefore(at("2026-08-13T10:00:00Z"), "not a cron", BERLIN)).toThrow(
            InvalidCronError,
        );
        expect(() => latestDueInstantBefore(at("2026-08-13T10:00:00Z"), "0 99 * * *", BERLIN)).toThrow(
            InvalidCronError,
        );
    });

    it("describes a due instant by its wall clock, not by its UTC spelling", () => {
        // `scheduledFor` is canonical UTC and the prompt is read by a model. "05:00:00Z
        // (Europe/Berlin)" invites the reading "05:00 local", which is precisely the ambiguity the
        // Accountant's 07:00 slot was chosen to avoid.
        expect(describeInstant("2026-08-13T05:00:00", BERLIN)).toBe("07:00 on 2026-08-13 (Europe/Berlin)");
        // Winter: the same wall clock, an hour later in UTC.
        expect(describeInstant("2026-01-13T06:00:00", BERLIN)).toBe("07:00 on 2026-01-13 (Europe/Berlin)");
        expect(describeInstant("2026-08-13T05:00:00", "UTC")).toBe("05:00 on 2026-08-13 (UTC)");
        // Never throws on a value it cannot parse: a prompt is not the place to fail.
        expect(describeInstant("not an instant", BERLIN)).toBe("not an instant (UTC)");
    });

    it("honours a timezone other than the configured default", () => {
        // 07:00 in Berlin and 07:00 in UTC are two hours apart in August, and the wrapper is told
        // which one it is rather than assuming.
        expect(latestDueInstantBefore(at("2026-08-13T10:00:00Z"), "0 7 * * *", "UTC")).toBe(
            "2026-08-13T07:00:00",
        );
    });
});
