# 02 — time-based scans (woken / expired-leases) use an unordered 100-row cap

**Severity:** MEDIUM · **Area:** runtime/watcher · **File:** `runtime/src/watcher/watcher.ts`
(`scanWoken`, `scanExpiredLeases`)

## Failure scenario
`scanWoken` (scan 3) queries `status = waiting AND wakeAt set`, capped at 100, with **no ordering and
no `wakeAt <= now` bound** — the "is it due yet" test is applied only *after* the page is fetched. With
>100 Conversations sleeping on `wakeAt`, the store returns an arbitrary 100; a page composed of
not-yet-due rows causes every row to be skipped, while genuinely-due Conversations at position 101+ are
never fetched and never woken — they miss their deadline indefinitely (the store can return the same
window each pass). `scanExpiredLeases` (scan 4) shares the identical unordered-cap shape.

## Root cause
The query neither bounds on `wakeAt <= now` (resp. `leaseUntil <= now`) nor orders by it, so the
100-cap is an arbitrary window over a set that can exceed it — the same starvation class scan 2 was
rewritten to eliminate.

## Fix
Constrain each query to the rows that are actually due (`date_range { field, to: now }`) so the capped
page contains due rows rather than an arbitrary window. (Ordering by the time field is an equivalent,
also-acceptable fix; the `date_range` bound is the smaller change and removes the not-yet-due rows from
contention entirely.)

## Verification
Unit test in `runtime/test/watcher.test.ts`: with >100 sleeping Conversations of which only a late-index
one is due, that one is still woken.
