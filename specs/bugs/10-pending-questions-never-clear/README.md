# 10 — the pending-questions overview never clears (answered questions stay forever)

**Severity:** MEDIUM (latent — overview is not currently in the nav menu) · **Area:** models · **Files:**
`import/models/openquestion/OpenQuestionPending_QeM.json`, `OpenQuestion_OM.json`

## Failure scenario
`OpenQuestionPending_QeM` filters solely on `AnsweredAt undefined_match`. But the Runtime **never stamps
`AnsweredAt`** — `isAnswered()` (watcher) treats any filled answer field (Text/Choice/Confirmed) as
answered and resumes the Conversation without writing the timestamp, and the `OpenQuestion_DM` field has
no default or computation. So an answered question still matches the pending filter and stays in the
`OpenQuestion_OM` list forever; re-answering does nothing to remove it. The query's definition of
"answered" (`AnsweredAt` set) contradicts the Runtime's (any answer field filled).

This overview is not reachable from the main menu today, so current user impact is latent — but the QM
is wrong, and anything that surfaces it (a re-added menu entry, a count badge) inherits a list that only
ever grows.

## Root cause
Two disagreeing definitions of "answered": the QM keys off a timestamp nothing writes.

## Fix
Make the QM match the Runtime's own definition: pending = every answer field unset
(`Text`, `Choice`, `Confirmed` all `undefined_match`, AND-ed), instead of `AnsweredAt undefined_match`.

## Verification
`node import/validate-models.mjs` passes; the constraint now references the fields `isAnswered` actually
reads. (A confirmed OpenQuestion no longer matches the pending constraint.)
