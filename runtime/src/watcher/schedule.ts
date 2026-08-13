/**
 * When was a Schedule last due?
 *
 * One function, and the reason it is its own module is that it owns the two decisions
 * [ADR-0016](../../../docs/adr/0016-a-schedule-fires-on-its-due-instant.md) made about daylight
 * saving — which is where "the same firing" stops being obvious:
 *
 *   - **the autumn hour that happens twice resolves to one instant and fires once**, and
 *   - **the spring hour that does not exist resolves to nothing and does not fire**.
 *
 * Hand-rolling cron-with-daylight-saving is a bad trade, so the arithmetic is `cron-parser`'s. What
 * lives here is the collapse rule, because `cron-parser` is right to report both occurrences of a
 * repeated wall-clock slot and we are the ones who have to decide that they are one slot.
 *
 * Only the **latest** due instant is ever returned. That is what makes catch-up-once fall out of the
 * mechanism rather than out of extra code: a daily schedule over a weekend the Runtime spent down
 * asks about Monday and never about Saturday.
 */

import { CronExpressionParser } from "cron-parser";

/**
 * Two consecutive slots cannot share a wall-clock reading more than twice — that is what a
 * one-hour repeat means — so this bound exists only so that a future timezone database with a
 * stranger rule in it cannot spin here.
 */
const MAX_COLLAPSE_STEPS = 4;

export class InvalidCronError extends Error {
    constructor(
        readonly cron: string,
        cause: unknown,
    ) {
        super(`"${cron}" is not a cron expression this Schedule can use: ${String(cause)}`);
        this.name = "InvalidCronError";
    }
}

/**
 * The most recent instant at or before `now` at which `cron` was due, in `timezone`, as a canonical
 * UTC ISO-8601 string with no milliseconds — the shape A12 stores and `exact_match` compares.
 *
 * `undefined` when the expression has never yet been due (a `0 9 1 1 *` evaluated in February of the
 * year it was written). Throws {@link InvalidCronError} when the expression does not parse, because
 * that is a configuration error on a Thing the User owns and the caller has to decide what to say
 * about it — it must not silently become "never due".
 */
export function latestDueInstantBefore(
    now: Date,
    cron: string,
    timezone: string,
): string | undefined {
    let walk;
    try {
        walk = CronExpressionParser.parse(cron.trim(), { tz: timezone, currentDate: now });
    } catch (error) {
        throw new InvalidCronError(cron, error);
    }

    let due: Date;
    try {
        due = walk.prev().toDate();
    } catch {
        // `prev()` throws rather than returning nothing once it runs out of range. A cron whose
        // first slot is still in the future is the ordinary case on a freshly configured Assistant.
        return undefined;
    }

    // The autumn-back hour: 02:30 local happens at 00:30Z and again at 01:30Z, and both are
    // genuinely "the 02:30 slot of that day". Collapsing onto the FIRST occurrence gives the slot
    // one identity, so the second occurrence recomputes to a `scheduledFor` that has already been
    // served and no second Conversation is born.
    const wallClock = wallClockIn(timezone);
    const slot = wallClock(due);
    for (let step = 0; step < MAX_COLLAPSE_STEPS; step += 1) {
        let earlier: Date;
        try {
            earlier = walk.prev().toDate();
        } catch {
            break;
        }
        if (wallClock(earlier) !== slot) break;
        due = earlier;
    }

    return toCanonicalUtc(due);
}

/**
 * A due instant as a human in that timezone reads it: `07:00 on 2026-08-13`.
 *
 * `scheduledFor` is a canonical **UTC** instant, so telling a model "05:00:00Z (Europe/Berlin)"
 * invites it to read 05:00 as local — and the whole reason the Accountant's schedule is at 07:00 is
 * that a run near midnight makes "today's unpaid set" ambiguous. So the prompt gets the wall clock.
 */
export function describeInstant(scheduledFor: string, timezone: string): string {
    const at = new Date(`${scheduledFor}Z`);
    if (Number.isNaN(at.getTime())) return `${scheduledFor} (UTC)`;
    const [date, time] = wallClockIn(timezone)(at).split(", ");
    return `${(time ?? "").slice(0, 5)} on ${date} (${timezone})`;
}

/** `2026-10-25 02:30:00` as that timezone reads it — the identity of a wall-clock slot. */
function wallClockIn(timezone: string): (at: Date) => string {
    const format = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    });
    return (at) => format.format(at);
}

/**
 * The same shape `nowIso` produces: A12's `DateTimeType` is modelled as `yyyy-MM-dd'T'HH:mm:ss`,
 * with no milliseconds and no zone suffix, and this value is compared with `exact_match` — so it has
 * to be spelled identically every time it is recomputed.
 */
function toCanonicalUtc(at: Date): string {
    return at.toISOString().replace(/\.\d{3}Z$/, "");
}
