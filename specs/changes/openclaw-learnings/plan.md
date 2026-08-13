# Plan

Three groups, **all independent of each other**. Any group may ship on its own — each ends with a
green `just test` and a system that works.

Ordered by value per unit of risk: the safety property first, the cheap one next, proactivity last.

## A — An Operation may require an approval (#1)

- [ ] Write the failing test first: a scripted transcript in which the model calls
      `bookkeeping__postTransaction` with **no approval**, asserting no Firefly call and an Open
      Question raised. Confirm it fails on `main`.
- [ ] Add `requiresApproval?: boolean` and `describeCall?(args): string` to `ToolDefinition` in
      `runtime/src/tools/registry.ts`.
- [ ] Set both on `bookkeeping.postTransaction` in `runtime/src/tools/tools.ts`. Write the renderer
      so it reads as a sentence: amount, source, destination, date, subject.
- [ ] Add `questionId?: string` to `Entry` in `runtime/src/domain/types.ts` and to
      `import/models/conversation/Conversation_DM.json`, plus the form-model field (ADR-0008). Set it
      in the watcher's answered scan (`runtime/src/watcher/watcher.ts`) on the `answer` entry it
      appends.
- [ ] Add the `approval-request` Entry kind, carrying `toolName`, `argsHash` and `questionId`.
- [ ] Add `canonicalArgsHash(args)` — sorted keys, normalised numbers — with a test that two
      differently-ordered encodings of the same call hash equal.
- [ ] Add `findApproval(conversation, operation, argsHash)` to `runtime/src/loop/advance.ts`: the
      walk-back from the architecture, returning *missing* / *waiting* / *declined* / *consumed* /
      *valid* rather than a boolean.
- [ ] Call it in the tool-call loop, after the intent is written and before `tools.execute`. On
      *missing*, raise the question via `raiseQuestion` — **not** `escalate()`, so `escalationCount`
      is untouched — and return `pending` / `waitingFor: user` with a note saying *refused pending
      approval, not queued*. No `wakeAt`.
- [ ] On *declined*, return `{ kind: "error", message: "The User declined this booking." }` and raise
      nothing.
- [ ] Confirm the new test passes and the existing suspend/resume tests still do.
- [ ] Add the refusal cases as tests: no request at all; `confirmed: false`; an approval already
      consumed by a previous call; and a second identical booking needing a second approval.
- [ ] Add the drift test: the model re-issues the call with a changed amount after the yes, and is
      asked again rather than booking.
- [ ] **Re-script the end-to-end invoice fixture.** Its model asks before booking and that ask no
      longer counts, so the transcript gains a refusal, an approval question and a resume.
- [ ] Run `just test-models`, `just test-runtime`, then `just test-e2e` against the stack.
- [x] **Written up front, before any code leans on it:**
      [ADR-0018](../../../docs/adr/0018-an-operation-may-require-an-approval.md), recording the
      decision and the four rejected alternatives — any answered `confirm` counts; the Runtime
      replays the approved arguments itself; `error` rather than `pending`; the flag on the Assistant
      rather than the Operation. The README's ADR count went from seventeen to eighteen with it.
- [ ] Update `specs/system/domain.md` (the rules), `specs/system/architecture.md` (the Tools table),
      `README.md` (*"Nothing is booked without an answer"* becomes structural rather than
      aspirational, and now costs a round trip) and `CONTEXT.md` — **already done: Approval added,
      and the Open Question entry's ban on the word narrowed rather than dropped.**

## C — Token usage on the Turn (#6)

- [ ] Add `usage?: { promptTokens: number; completionTokens: number }` to `LlmResponse` in
      `runtime/src/llm/provider.ts`.
- [ ] Read it in `runtime/src/llm/openai.ts` and `runtime/src/llm/anthropic.ts`; return zeroes from
      `runtime/src/llm/scripted.ts`.
- [ ] Add the two fields to `Entry` in `runtime/src/domain/types.ts` and to
      `import/models/conversation/Conversation_DM.json`, plus the form-model entry (ADR-0008). Not
      indexed — nothing queries them.
- [ ] Write them onto **the first Entry the Turn wrote** in `advance()`: the `assistant` entry for a
      text reply, the first `tool-intent` otherwise.
- [ ] Test: a Turn against a provider reporting usage records it; a tool-calling Turn records it on
      the first intent; a scripted Turn records zeroes; a Turn that errored records nothing.
- [ ] Update `specs/system/domain.md` with the lower-bound caveat — a Turn that errored records no
      usage, so a Conversation's Turns sum to a lower bound on its cost, not its cost.
- [ ] `just test-models` and `just test-runtime`.

## B — The seventh scan, quiet when idle (#2, #7, #11)

- [ ] Add `cron-parser` as a runtime dependency, pinned per D-006.
- [ ] Add `latestDueInstantBefore(now, cron, timezone)` with tests covering: never-yet-due, a normal
      slot, the spring-forward slot that does not exist, and the autumn-back slot that happens twice.
      These are the cases ADR-0016 exists for, so they are written first.
- [ ] Add `SCHEDULE_TIMEZONE` to `runtime/src/config.ts` and `.env.example`.
- [ ] Add indexed `scheduledFor` to `Conversation_DM` and its form model; add it to the
      `Conversation` type and to `SPECS` in `runtime/src/a12/things.ts`.
- [ ] Add `conversationExistsFor(assistantKey, scheduledFor)` and
      `anyUnfinishedScheduledConversation(assistantKey)` beside the existing subject-Thing query in
      `runtime/src/watcher/watcher.ts`.
- [ ] Add scan 7, honouring `paused`, `enabled` and the births-per-hour cap; skip on an unparseable
      cron, logging once per Assistant **per process** via an in-memory `Set`.
- [ ] Test exactly-once across a re-scan, a restart and a replayed watermark; that three missed slots
      produce **one** Conversation; and that a slot is skipped while the previous one is unfinished.
- [ ] Extend the scheduled birth prompt: if there is nothing to do, say so briefly and finish without
      raising an Open Question. Order the prompt stable-first, volatile-last, and say so in a comment
      — `scheduledFor` is the first varying value to reach it (#11).
- [ ] Test that a scheduled Conversation finding nothing ends `done` with no `OpenQuestion` created.
- [ ] Give the Accountant a **daily** cron so the path is exercised — its *"chase what is unpaid"*
      Skill already exists and has no way to run.
- [ ] **Rewrite that Skill to batch**: gather everything unpaid and raise **one** question covering
      all of it. One question per invoice stalls the schedule on the first, because of the skip rule.
      Add a test with two unpaid invoices asserting exactly one Open Question.
- [ ] Update `specs/system/domain.md`, `functional.md`, `architecture.md` and `README.md`: a Schedule
      Trigger is no longer inert. **Six documents currently say it is** — `grep -rn` before claiming
      this is done.
- [ ] `CONTEXT.md` — **already done: Schedule gained catch-up-once and stalls-rather-than-accumulates.**

## Closing out

Three records are **already written**, because two of them are decisions *not* to build and would
have been buried by `/spec:archive`:

- [x] ADR-0016's consequences gained the reason a Schedule needs no auto-disable — where a reader
      arriving from OpenClaw will look for it.
- [x] `specs/system/architecture.md` gained the `raiseQuestion`-is-the-seam note, the reason
      `ui.askUser` is the wrong hook, and the non-fatal requirement.
- [x] The learnings table now carries the reversed verdicts: 5 and 8 rejected as subsumed by
      ADR-0016, 3 adopted-as-the-design but unbuilt with its seam, and the sharpenings planning found
      for 1, 6 and 7.

Then:

- [ ] Mark 1, 2, 6, 7 and 11 **built** in the learnings table, with their ADR numbers.
- [ ] `just check` and the full `just test` with the stack up.
- [ ] `/spec:archive`.
