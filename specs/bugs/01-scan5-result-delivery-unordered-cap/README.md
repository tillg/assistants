# 01 — scan 5 (result delivery) uses an unordered 100-row cap with no cursor

**Severity:** HIGH · **Area:** runtime/watcher · **File:** `runtime/src/watcher/watcher.ts` (`scanResultDelivery`)

## Failure scenario
`scanAnswered` (scan 2) was fixed to page an unbounded set with oldest-first ordering + a rotating
cursor (`answeredCursor`) so no waiting Conversation is ever shadowed. **Scan 5 (delivering a finished
child's result to its parent) never got that fix** — it calls `things.search(Conversation_DM, …, 100)`
with no sort and no cursor. The store always returns `pageNumber: 0`, so it is an *arbitrary* window of
100.

Two consequences:
1. A child whose parent was deleted by hand makes `get(parent)` throw; that is caught and logged
   "will retry", and `resultDeliveredAt` is **never** stamped — the row stays in the result set forever.
   Accumulate ≥100 such stuck rows and the unordered page fills with them every pass; genuinely
   deliverable children queued behind them never enter the window, so their parents wait on
   `assistant` **forever**, with only a warn line as evidence. Health checks stay green.
2. Even without stuck rows, a burst fan-out of >100 finished children delivers only 100 per pass.

## Root cause
The ordering+cursor treatment applied to `scanAnswered` was not applied to `scanResultDelivery`, which
is *more* exposed because its population is machine-generated (fan-out) and contains permanently-sticky
rows on the deleted-parent path.

## Fix
Give scan 5 oldest-first ordering + a rotating `resultDeliveryCursor` across passes (mirroring
`scanAnswered`), and additionally stop a genuinely-absent parent from sticking (a deleted parent can
never receive a result → treat as delivered-to-nobody so it leaves the set).

## Verification
Unit test in `runtime/test/watcher.test.ts`: with >100 finished undelivered children where the oldest
are stuck (deleted parent), a deliverable newer child is still delivered within a bounded number of
passes.
