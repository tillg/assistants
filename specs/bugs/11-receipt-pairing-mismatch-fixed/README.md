# 11 — a Receipt pairs a result to the wrong call of the same tool

**Severity:** MEDIUM · **Area:** client/conversation · **File:**
`client/src/components/conversation/entries.ts` (`pairIntoReceipts`)

## Failure scenario
Pairing matches a `tool-result` to a `tool-intent` by `toolName` alone, searching forward for the first
unclaimed same-name result. When an earlier call died without a result and the assistant then called the
*same* tool again and that one returned — entries `[intent(fetch), intent(fetch), result(fetch)]` — the
first (dead) intent claims the *second* call's result. So the first Receipt shows call #1's arguments
next to call #2's result (misleading when a user opens it to debug), and the second Receipt — the one
that actually succeeded — renders as "no result".

## Root cause
No correlation between an intent and its result other than `toolName`; the forward-search + `claimed`
set assigns the earliest unclaimed same-name result to the earliest intent, which is wrong when an
earlier intent had no result of its own.

## Fix
Bound the forward search: stop at the next `tool-intent` of the same `toolName` (a same-tool intent
appearing before any result means the current intent has no result of its own). Minimal change inside
the `.find`.

## Verification
Unit test in `client/src/test/components/conversation/entries.test.ts`: entries
`[intent A, intent A, result A]` produce a first receipt with **no** result and a second receipt paired
to the result.
