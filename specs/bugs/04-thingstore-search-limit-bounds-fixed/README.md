# 04 — `thingstore.search` accepts a negative or fractional `limit`

**Severity:** LOW · **Area:** runtime/operations · **File:**
`runtime/src/operations/implementations.ts` (`thingstore.search` execute)

## Failure scenario
`const limit = Number(args["limit"] ?? 25) || 25;` — only `0`/`NaN` (falsy) fall back to 25. A model
sending `limit:-5` keeps `-5`; `limit:3.7` keeps `3.7`. The upper guard (`limit > PAGE_SIZE_MAX`) does
not catch these, so a negative/fractional `pageSize` reaches the store, which answers with an opaque
RPC error the model cannot act on (or an unintended window) instead of a clear tool error.

## Root cause
The coercion only defends against falsy values, not against negative or non-integer ones. The sibling
`bookkeeping.listTransactions` already clamps with `Math.max(1, Math.floor(...))`.

## Fix
Clamp to a positive integer before the upper-bound check: `Math.max(1, Math.floor(limit))`.

## Verification
Unit test in `runtime/test/operations.test.ts`: `thingstore.search` with `limit:-1` and `limit:3.7` is
coerced to a valid positive integer page size (no store error).
