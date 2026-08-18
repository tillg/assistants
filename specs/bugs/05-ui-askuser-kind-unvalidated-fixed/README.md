# 05 — `ui.askUser` does not validate `kind`; a model can mint a `perform` question

**Severity:** LOW · **Area:** runtime/operations · **File:**
`runtime/src/operations/implementations.ts` (`ui.askUser` execute)

## Failure scenario
`const kind = String(args["kind"] ?? "free-text") as "free-text" | "confirm" | "choice";` — the cast is
a lie: nothing enforces it at runtime, and `raiseQuestion`'s type also accepts `"perform"`. The seed
schema's enum lists only `free-text|confirm|choice`. So an Assistant that is granted no manual connector
can call `ui.askUser` with `kind:"perform"` and an arbitrary prompt, producing a `perform`-kind
OpenQuestion — the same "please do this by hand" surface that only granted connectors
(`bank.sendMoney`, `email.send`) are meant to present. Impact is UI/social-engineering (no capability is
wired behind it), but it defeats the grant model's premise that perform-questions come from granted
connectors. It also lets a model emit a `kind` outside the documented enum.

## Root cause
The declared enum is never enforced in `execute`.

## Fix
Reject a `kind` not in `["free-text","confirm","choice"]` with a tool error before calling
`raiseQuestion`.

## Verification
Unit test in `runtime/test/operations.test.ts`: `ui.askUser` with `kind:"perform"` (and with a garbage
kind) returns an `error` outcome and raises no question.
