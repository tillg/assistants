# 03 — `thingstore.update` lets a model overwrite a Thing's machine fields

**Severity:** MEDIUM · **Area:** runtime/operations · **File:**
`runtime/src/operations/implementations.ts` (`thingstore.update` execute)

## Failure scenario
`thingstore.create.execute` deliberately overrides the machine fields after spreading the model's
input: `{ ...fields, idempotencyKey: context.idempotencyKey, createdByConversationId: … }`.
`thingstore.update.execute` does **not** — it builds `const merged = { ...fields }` with no
machine-field stripping. Every WRITABLE model's `spec.fields` includes the four machine fields, so a
model that puts `idempotencyKey` (or `createdByConversationId` / `createdAt`) inside an update's
`fields` silently rewrites the Thing's dedup / provenance anchor.

Example: an Assistant granted `thingstore.update` issues
`update(Process_DM, X, { status:"done", idempotencyKey:"convY:3" })`. The Process's stored idempotency
key is replaced. Crash-recovery (`findByIdempotencyKey`, the `create`/`assistant.call` reconcilers) all
key off this field; a collided or blanked key makes recovery match the wrong Thing or none. No approval,
no crash required — just the field name.

## Root cause
Asymmetry: `create` guards machine fields, `update` does not.

## Fix
In `thingstore.update.execute`, drop the machine fields from `fields` before merging (mirror the create
guard): strip `idempotencyKey`, `createdByConversationId`, `createdAt`, `updatedAt`. (`updatedAt` is
already force-stamped by `ThingRepository.update`.)

## Verification
Unit test in `runtime/test/operations.test.ts`: `thingstore.update` with a machine field in `fields`
leaves the stored machine field unchanged.
