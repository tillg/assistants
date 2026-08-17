import { format } from "date-fns";

/**
 * The footer line every Tile that read something carries: *as of 14:32*.
 *
 * A Tile states the instant it read because nothing on this Dashboard polls (ADR-0022 — it counts, it
 * does not keep), so a stale number must never be mistaken for a live one. Shared rather than repeated,
 * because three Tiles say it and they must say it the same way.
 */
export function asOf(readAt: Date): string {
    return `as of ${format(readAt, "HH:mm")}`;
}
