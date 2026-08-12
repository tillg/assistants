# Plan

Five groups. **A, B and D are independent of each other; C needs B; E is independent of everything.**
Any group may ship on its own — each ends with a green `just test` and a system that works.

Ordered by value per unit of risk: the safety property first, the cheap one next, proactivity
after that, the outward-facing one last.

## A — An Operation may require an answered Open Question (#1)

- [ ] Write the failing test first: a scripted transcript in which the model calls
      `bookkeeping__postTransaction` **without** asking, asserting no Firefly call and an Open
      Question raised. Confirm it fails on `main`.
- [ ] Add `requiresApproval?: boolean` to `ToolDefinition` in `runtime/src/tools/registry.ts`.
- [ ] Set it on `bookkeeping.postTransaction` in `runtime/src/tools/tools.ts`.
- [ ] Add `findUnconsumedApproval(conversation, operation)` to `runtime/src/loop/advance.ts` —
      the walk-back described in the architecture, including the consumed-by-an-earlier-call rule.
- [ ] Call it in the tool-call loop, after the intent is written and before `tools.execute`;
      on a miss, raise the Open Question and return `pending` / `waitingFor: user`.
- [ ] Confirm the new test passes and the existing suspend/resume tests still do.
- [ ] Add the three refusal cases as tests: no answer, an explicit `confirmed: false`, and an
      approval already consumed by a previous call.
- [ ] Run `just test-runtime`, then `just test-e2e` against the stack — the scripted invoice
      slice asks before booking, so it must stay green.
- [ ] Write ADR-0018 recording the decision and the two rejected alternatives (error rather than
      pending; the flag on the Assistant rather than the Operation).
- [ ] Update `specs/system/domain.md` (the rule), `specs/system/architecture.md` (the Tools table),
      `README.md` (*"Nothing is booked without an answer"* becomes structural rather than
      aspirational) and `CONTEXT.md` (**Approval**).

## D — Token usage on the Turn (#6)

- [ ] Add `usage?: { promptTokens: number; completionTokens: number }` to `LlmResponse` in
      `runtime/src/llm/provider.ts`.
- [ ] Read it in `runtime/src/llm/openai.ts` and `runtime/src/llm/anthropic.ts`; return zeroes
      from `runtime/src/llm/scripted.ts`.
- [ ] Add the two fields to `Entry` in `runtime/src/domain/types.ts` and to
      `import/models/conversation/Conversation_DM.json`, plus the form-model entry (ADR-0008).
      Not indexed — nothing queries them.
- [ ] Write them onto the `assistant` Entry in `advance()`.
- [ ] Test: a Turn against a provider reporting usage records it; a scripted Turn records zeroes.
- [ ] `just test-models` and `just test-runtime`.

## B — The seventh scan (ADR-0016)

- [ ] Add indexed `scheduledFor` to `Conversation_DM` and its form model; add it to the
      `Conversation` type and to `SPECS` in `runtime/src/a12/things.ts`.
- [ ] Add `latestDueInstantBefore(now, cron, timezone)` with tests covering: never-yet-due, a
      normal slot, the spring-forward slot that does not exist, and the autumn-back slot that
      happens twice. These are the cases ADR-0016 exists for, so they are written first.
- [ ] Add `SCHEDULE_TIMEZONE` to `runtime/src/config.ts` and `.env.example`.
- [ ] Add `conversationExistsFor(assistantKey, scheduledFor)` beside the existing
      subject-Thing query in `runtime/src/watcher/watcher.ts`.
- [ ] Add scan 7, honouring `paused`, `enabled` and the births-per-hour cap; log-once and skip on
      an unparseable cron.
- [ ] Test exactly-once across a re-scan, a restart and a replayed watermark; and that three
      missed slots produce **one** Conversation.
- [ ] Give one seeded Assistant a real schedule so the path is exercised — the Accountant's
      *"chase what is unpaid"* Skill already exists and has no way to run.
- [ ] Update `specs/system/domain.md`, `functional.md`, `architecture.md` and `README.md`: a
      Schedule Trigger is no longer inert. **Six documents currently say it is** — `grep -rn`
      before claiming this is done.

## C — Quiet when idle, disabled when failing (#5, #7) — *needs B*

- [ ] Extend the scheduled birth prompt: if there is nothing to do, say so briefly and finish
      without raising an Open Question.
- [ ] Add a Skill to the scheduled Assistant saying the same, and a test that a scheduled
      Conversation finding nothing ends `done` with no `OpenQuestion` created.
- [ ] Add `scheduleFailures: { assistantKey, count }[]` to `RuntimeState_DM` and its form model.
- [ ] Increment on a scheduled Conversation ending `failed` or hitting its third escalation;
      reset to zero on one ending `done`.
- [ ] At the threshold (five), skip the Assistant in scan 7 and raise **one** Open Question
      explaining the suspension; clear the counter when it is answered.
- [ ] Test: five consecutive failures suspend and ask once — not five times; answering resumes;
      a success in between resets the count.
- [ ] Update `specs/system/functional.md` (a new way to be asked something) and `CONTEXT.md`
      (**Schedule** gains catch-up-once and self-suspension).

## E — Open Questions on a messenger (#3)

- [ ] Write ADR-0019 first: the Connector authenticates as a human identity of its own, and why
      options 2 and 3 were rejected. This is the ADR-0014 collision and it should be decided in
      writing before any code.
- [ ] Add a `notify` Keycloak user in the `user` role, its credential generated by
      `scripts/setup-env.mjs` into `.env` like every other machine credential (D-023).
- [ ] Add the Connector in `runtime/src/connectors/`, with `notify.ask` (post an Open Question and
      return `pending`) and the poll that brings a reply back and writes it **as that user**.
- [ ] Post the question and a deep link only — never the subject Thing's contents.
- [ ] Register it as an Operation; grant it to no Assistant initially. It is reached because
      `ui.askUser` also notifies, not because an Assistant chose it.
- [ ] Integration test against the live stack; skipped rather than failed when unconfigured, like
      the other integration specs.
- [ ] Update `README.md`: *"nothing leaves the machine except calls to the configured LLM API"* is
      no longer true, and the security posture section gains the outbound surface and the stored
      human credential.
- [ ] Update `CONTEXT.md` (**Notification Connector**) and `specs/system/architecture.md`.

## Closing out

- [ ] `just check` and the full `just test` with the stack up.
- [ ] Re-read `ASSISTANTS_VS_OPENCLAW.md`'s learnings table and mark 1, 3, 5, 6 and 7 as built,
      with the ADR numbers.
- [ ] `/spec:archive`.
