# 20 — `check-docs.mjs` breaks once there are ≥26 ADRs

**Severity:** LOW · **Area:** scripts · **File:** `scripts/check-docs.mjs`

## Failure scenario
`NUMBER_WORDS` runs `zero … twenty-five` (indices 0–25). At `adrCount === 26`,
`expectedWord = NUMBER_WORDS[26]` is `undefined`. Any README line matching
`"<number-word> architecture decision"` then fails the `said !== expectedWord` test and reports a
spurious error ending `"… (undefined)"`, and no ADR count above 25 can ever be validated. The file's own
header notes the count already grew 10→15, so 26 is plausible.

## Root cause
The number-word table is finite (0–25) and the check assumes the current README word is always in range.

## Fix
Guard the out-of-range case: when `expectedWord === undefined`, emit a clear actionable failure
("extend NUMBER_WORDS past N") instead of comparing against `undefined` — and extend `NUMBER_WORDS`
through at least `thirty` so the current growth range is covered.

## Verification
`node scripts/check-docs.mjs` passes on the current tree; reasoning covers the ≥26 case (no undefined
comparison).
