# 06 — interrupted `replace:true` re-read reconciles as success on stale text

**Severity:** LOW-MEDIUM · **Area:** runtime/operations · **File:**
`runtime/src/operations/implementations.ts` (`document.readScan` / `document.extractText` `reconcile`,
via `textOnDocument`)

## Failure scenario
Both reconcilers ask only "does the Document have any text now?" (`extractedText.trim().length > 0`).
They cannot tell *old* text from *newly-written* text. When the original call was `replace:true` over an
already-populated field and the Turn crashed after the download/vision step but before `things.update`,
the pre-existing text makes `characters > 0`, so reconcile returns `{ alreadyRead: true }`.

A Document holds a human transcription (or a stale scan). The model calls
`document.readScan(thingId, replace:true)` because the user asked to re-read it; the Turn is interrupted
before the write. Recovery's reconcile sees the *old* text and reports success — the model believes the
re-read landed and proceeds on stale text, and for `readScan` the paid re-read is silently skipped.

## Root cause
Reconcile treats "field non-empty" as "my write happened", which is only valid when the call was an
*append to empty*, not a `replace` over existing content.

## Fix
When `args.replace` is truthy, a reconcile cannot prove the overwrite happened, so return the
interrupted-error outcome ("reading it again costs money; do it only if still worth it") instead of the
`alreadyRead` value. The non-replace path is unchanged.

## Verification
Unit test in `runtime/test/operations.test.ts`: `reconcile` of `readScan`/`extractText` with
`replace:true` on a Document that already has text does **not** return `alreadyRead`.
