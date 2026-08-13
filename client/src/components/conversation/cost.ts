import type { TranscriptEntry } from "./entries";

/**
 * What a Conversation has cost, summed over its Entries.
 *
 * Summing every Entry is correct rather than sloppy: `recordUsage` stamps a Turn's usage onto the first
 * Entry that Turn wrote and leaves the rest unset, so there is nothing to double-count. What there is
 * instead is a systematic undercount — a Turn that died before writing an Entry recorded nothing — which
 * is why the figure is always rendered with a `≥` and never as a total. A bare number would be a false
 * claim, and this is the first place in the system where that claim becomes visible to the User.
 */

/** The sum of prompt and completion tokens over the Entries. A lower bound, never a total. */
export function recordedCost(entries: readonly TranscriptEntry[]): number {
    return entries.reduce((total, entry) => total + (entry.promptTokens ?? 0) + (entry.completionTokens ?? 0), 0);
}

/**
 * The Header's cost line. The locale is a parameter only so that the grouping can be shown to come from
 * `Intl` rather than from a separator of our own; callers pass nothing and get the browser's.
 */
export function formatRecordedCost(total: number, locale?: string): string {
    return `≥ ${new Intl.NumberFormat(locale).format(total)} tokens`;
}
