# Decisions and assumptions made while applying `openclaw-learnings` unattended

Written as the work happened, for review. Every entry is a fork the plan or the architecture left
open, the reading chosen, and why. Where an artefact was ambiguous the reading is named; the one place
an artefact turned out to be **wrong** is R-1, and it is corrected in the artefact rather than quietly
contradicted in the code.

Session date: 2026-08-13.

## The short version

All three groups are built and all five test tiers are green: 26 models, 120 runtime units, 68
live-stack integration tests, 288 client units, 30 end-to-end. `just check` is clean.

Read these five if you read nothing else:

| | What |
|---|---|
| **R-1** | The architecture's `consumed` rule was wrong — a rejected booking consumed its approval. Fixed in code *and* in `architecture.md` |
| **A-3** | The only thing no artefact decided: an answer without an explicit tick counts as a **no** |
| **R-2** | The skip-rule warning would have logged 43,200 lines a day. Now once, after thirty minutes |
| **B-2**/**B-4** | `SCHEDULE_TIMEZONE=Europe/Berlin` and the Accountant's `0 7 * * *` are choices, not design |
| **Last section** | Two pre-existing problems noticed and deliberately left alone |

Three things changed that the plan did not name: the `2-restart` end-to-end test (it waited for a
state this Conversation legitimately no longer reaches), the Open Questions page object (one
Conversation now owns more than one row), and `validate-models.mjs` (a missing guard on the one field
scan 7 depends on).

---

## A — An Operation may require an approval

### A-1 · The `approval-request` Entry carries no `text`

The architecture says the entry carries `toolName`, `argsHash` and `questionId`. It does not say
whether it also carries prose. It does not, and that is deliberate:

- `buildMessages` maps an unknown `kind` with a `text` to a **user** message. An entry written
  between the `tool-intent` and its `tool-result` would therefore interleave a user message between
  an assistant tool call and its result — which Anthropic rejects outright (a `tool_result` must be
  the first block of the user turn that follows).
- The alternative was teaching `buildMessages` to skip a kind, which the architecture already
  rejected once (for a `kind: "usage"` entry).
- The prompt's Authority is the Open Question (ADR-0006). A copy in the transcript would be a second
  one.

So the entry is machine-readable only, and produces no message. The model learns of the refusal from
the pending `tool-result`, which is where the architecture puts that sentence anyway.

### A-2 · `Entry.argsHash` is a new field rather than a reuse of `toolArgs`

`Entry` had nowhere to put the hash. Overloading `toolArgs` or `idempotencyKey` would have made the
walk-back read a field that means something else on every other kind. One more `StringType` on the
`Entries` group is cheaper than that ambiguity.

### A-3 · An answered approval whose `Confirmed` is not `true` counts as **declined**

The architecture names two answered cases: `confirmed: true` (valid) and `confirmed: false`
(declined). It does not name the third: `isAnswered()` is deliberately generous, so a User who types
text into the answer field and leaves the tri-state Boolean unset has *answered* — and the watcher
will resume the Conversation on that basis.

Treating that as "still waiting" would loop: the Conversation resumes, the model calls again, the
check refuses again, forever until `maxTurns`. Treating it as a fresh *missing* approval would ask
the same question again, which is the re-asking the domain rules forbid.

So anything that is not an explicit `true` is a **no**, and the model is told so plainly. The
message says which it was, so a User who meant yes and forgot the tick can see why nothing happened.
"Nothing is booked without an answer" reads *explicit yes* or nothing.

### A-4 · A *consumed* approval raises a fresh question, and that is the same code path as *missing*

The five states in the architecture collapse to three outcomes: raise-and-suspend (missing,
consumed), suspend-on-the-existing-question (waiting), and error (declined). The walk-back takes the
**last** `approval-request` for the pair, so a freshly raised one supersedes the consumed one without
any bookkeeping.

### A-5 · `bookkeeping.createAccount` does **not** set `requiresApproval`

The architecture says it "would if it were ever granted" — and it is not granted to any Assistant.
Setting the flag on an unreachable Operation would add an untested path. Left off, with the reason
recorded in `tools.ts` beside the flag that is on.

### A-6 · The approval question's idempotency key is derived from the arguments, not the sequence

`approval:<conversationId>:<first 16 hex of argsHash>:<attempt>` — 64 characters, well inside the
store's 100-character `exact_match` ceiling.

The obvious choice was the entry's own sequence number, the shape `escalate()` uses
(`<id>:escalation:<n>`). It is wrong here, because of a window: the question is created *before* the
`approval-request` Entry that records it, so a crash in between leaves an Open Question with nothing
pointing at it. Recovery then reconciles the intent, the model calls again, the transcript has moved
on, and a sequence-derived key would mint a **second** question while the first sat unanswered in the
inbox for ever.

Keyed on the arguments and the attempt number instead, the retry computes the same key, `create` finds
the question already there, and the orphan is adopted. `attempt` is the number of existing
`approval-request` entries for that (Operation, argsHash) plus one, which is what makes A-4's second
approval of an identical call a distinct question.

### A-7 · `describeCall` renders the sentence; the Runtime adds the framing

`postTransaction.describeCall` returns *"Book €96.50 from Payables to Expenses:Health, dated
2026-08-01, for Consultation and dressing change."* The **Approval needed.** heading and the closing
sentence are added by the Runtime, so every approval question reads the same way regardless of which
Operation raised it, and a missing renderer degrades to the JSON fallback without losing the framing.

---

## C — Token usage on the Turn

### C-1 · Usage is written before the write that persists the entry

For a text reply the fields go on the `assistant` entry before `write()`. For a tool Turn they go on
the **first** `tool-intent` before the write that the intent-before-execution rule already performs.
No extra store write is added by item 6.

### C-2 · Zeroes are written, not omitted

`ScriptedProvider` returns `{promptTokens: 0, completionTokens: 0}` and those zeroes are written. An
absent field and a zero field would otherwise be indistinguishable, and the plan asks for a test
that a scripted Turn records zeroes — which requires them to be there.

### C-3 · The two fields are visible in the transcript as columns

They are added to the `Entries` inline repeat as two narrow columns. Nothing aggregates them
(non-goal), but the record has to be readable somewhere or item 6 buys nothing at all. This is the
"the record, not a second store" argument applied to its own output.

---

## B — The seventh scan

### B-1 · `cron-parser@5.8.1`, pinned exactly

D-006 pins artefacts, so the dependency is added as `"cron-parser": "5.8.1"` — no caret — and the
lockfile is committed. It is the only runtime dependency besides `undici`.

### B-2 · `SCHEDULE_TIMEZONE` defaults to `Europe/Berlin`

The system is a German household's administration (German invoices, GOÄ, `de` locale on every
model). `UTC` would have been the neutral default and would have made the daylight-saving cases the
wrapper exists for unreachable in practice. Europe/Berlin is the honest default and exercises them.

### B-3 · The scheduled birth prompt is ordered stable-first, volatile-last (#11)

`scheduledFor` is the last line of the prompt, after the standing instruction, with a comment saying
why. The rule is written into `specs/system/architecture.md` rather than only into the comment.

### B-4 · The Accountant's daily cron is `0 7 * * *`

07:00 local, so a chase lands before the working day rather than at midnight, where "today's" unpaid
set is ambiguous. A daily schedule is one Conversation a day, which the architecture calls the
honest floor.

### B-5 · The unparseable-cron log set is keyed by Assistant **key**

Per the architecture: in-memory, so once per process. Keyed on the key rather than the docRef so a
re-seeded Assistant is not re-warned.

---

## Cross-cutting

### X-1 · `birth()` gains an optional `scheduledFor`

`WatcherDeps.birth` and both implementations (`services.ts`, the test harness) gain
`scheduledFor?: string`. It is optional, so the five existing callers are untouched.

### X-2 · Three things were changed that the plan did not name

All three are consequences of item 1 rather than scope creep, and each is a test or a guard rather
than product code:

- **`e2e/tests/flow/2-restart.spec.ts`** waited for its Conversation to stop being `waiting` on
  `user`. Answering the Accountant's own question now moves it straight onto the Runtime's approval,
  so that is a state this Conversation legitimately never reaches again. It now waits for the answer
  to be *consumed* — `currentQuestionId` is no longer the question it was given — which is what
  "continued" always meant and is what the test's own assertion (`["running","waiting","done"]`)
  already allowed for.
- **`e2e/pages/OpenQuestionPage.ts`** asserted exactly one row per Conversation in the Open Questions
  overview. A booking now raises two questions, and an answered one does not leave that view (see the
  pre-existing note at the end), so the row is picked by the first line of its prompt.
- **`import/validate-models.mjs`** gained `f_scheduledFor` in `WATCHER_FIELDS` — see R-1's siblings.

### X-3 · Entry group fields are exempt from the ADR-0008 form check

`validate-models.mjs` skips fields inside a repeating group for the "invisible in the UI" warning
(`if (field.group) continue`). The new entry fields are nonetheless given `fieldConfiguration`
entries so they behave the same way the existing ones do (read-only), and `scheduledFor` — a
top-level scalar, which *is* checked — gets a control on the Conversation form and a column on its
overview.

---

## What the review pass changed

An adversarial review of the finished diff found seven things. All seven are fixed; two of them
matter.

### R-1 · The architecture's `consumed` predicate was wrong, and is corrected in both places

The artefact prescribed *"a tool-result for this Operation follows the answer → consumed"*. Every
refusal **and every rejection** is recorded as a `tool-result` for the Operation, so a Firefly 422 —
after which nothing whatsoever was booked — consumed the approval. The model then retried the
identical call, exactly as `postTransaction`'s own description invites it to (*"Safe to retry"*), and
the User was asked a second time for a booking that had never happened. That is the
question-per-retry the whole mechanism exists to bound, sitting on the most ordinary error path there
is.

**Spent now means executed, not attempted.** The `argsHash` is written onto the *tool-result* too,
and only where the Operation ran and returned a value — including on the reconciliation path, so a
booking that turns out to have landed still spends its approval and two identical bookings still need
two approvals (ADR-0012). Reading a structured field is also what keeps the promise that the prose is
never parsed; the alternative was sniffing the result text for `Error:`.

This is a **deviation from `architecture.md`**, so the artefact is corrected rather than quietly
contradicted, and there is a test for the 422 retry.

### R-2 · The skip-rule warning would have logged 43,200 lines a day

`scanScheduled` warned unconditionally on every held slot, every two seconds. The stall is the
skip rule *working*, and after item 1 it is the common case — the Accountant waits on an approval at
least once per booking. It now follows the shape ADR-0016 actually asked for ("warned about the way a
pinned watermark is"): once, and only after the slot has been held for thirty minutes, so an approval
answered over a cup of coffee produces no line at all.

### The other five, all small

- **The birth-budget check ran before the already-served check**, so an exhausted hour warned on every
  scan about a birth that could never happen — and ADR-0016 promises a served slot "costs one
  comparison and no query". Reordered.
- **`f_scheduledFor` was missing from `validate-models.mjs`'s `WATCHER_FIELDS`.** The annotation is
  correct, so nothing was broken — but the guard that would catch it being dropped was absent, and
  the failure it guards against is a Conversation born on every scan. Added.
- **The scheduled prompt labelled a UTC instant with the cron's timezone** — `05:00:00Z
  (Europe/Berlin)` — inviting a model to read 05:00 as local, which is the midnight ambiguity the
  07:00 slot was chosen to avoid. It now renders the wall clock: `07:00 on 2026-08-13
  (Europe/Berlin)`.
- **`questionId` and `argsHash` were configured but never rendered.** They are the diagnostic when an
  approval misbehaves, and the two token fields added in the same change *did* get columns. Both now
  have one.
- **A malformed `splits` produced "Book a transaction with no postings?"** — a safety question
  describing nothing. It now falls through to the JSON block, which is what the fallback is for.

The review confirmed, by tracing rather than by testing, that there is no path to an approval bypass
and no livelock, and that the daylight-saving arithmetic is right in both directions.

## Open for the User

Nothing here is blocking. Four things are worth a glance:

- **R-1** is a correction to `architecture.md`, not merely to the code. Worth reading, because the
  reasoning behind the original rule was sound and the rule was still wrong.
- **A-3** is the only place this change decides something no artefact decided: an answer without an
  explicit tick is a **no**. The opposite reading (ask again) is defensible and is one line to change.
- **B-2**/**B-4** are configuration choices, not design.
- **A schedule fires the moment it is configured**, because a cron expression has no start date, so
  the latest due instant is always in the past. Adding the Accountant's `0 7 * * *` births one
  Conversation on the next scan. Correct per ADR-0016 — a Schedule is a standing instruction about the
  state of the world *now* — but a surprise, so it is asserted in a test and written into the README.

## What was verified against the running stack

Beyond the five test tiers, three things were exercised by hand because a green suite is not evidence
that the mechanism does what it claims.

**Item 7, live.** On the first scan after bootstrap, scan 7 birthed one Conversation for
`scheduledFor: 2026-08-13T05:00:00` (07:00 Berlin), it took one Turn, and it finished `done` with no
Open Question raised. A restart of the Runtime produced no second birth for the same slot.

**The approval paths the e2e tier does not cover, at volume.** Eight arriving Documents, answered
three ways — yes, an explicit no, and text without the tick — 41 assertions, all passing:

- the three yeses booked, and Firefly gained **exactly** three transactions;
- the three noes and the two text-only answers booked nothing, were told plainly which it was, and
  raised **no** second question;
- no Conversation escalated, and none reached `failed`;
- every transcript carried what its Turns cost;
- no schedule slot was served twice throughout.

Most importantly: in all eight, the User said **yes to the Assistant's own polite question** first,
and that booked nothing. That is item 1's whole claim, observed eight times.

**The new fields in the UI.** The Conversations overview shows a populated `Scheduled for` column;
the transcript shows `Question`, `Arguments hash`, `Prompt tokens` and `Completion tokens`; and the
approval question renders in the inbox as a sentence — *"Book €96.50 from Payables to
Expenses:Health, dated 2026-08-01, for …?"* — which is where the awkward comma in the first version
of the renderer was spotted and fixed.

## Two pre-existing things noticed, not changed

Neither is caused by this change; both are mentioned rather than fixed, and the second is now more
visible because of it.

- **An answered Open Question does not leave the "pending" view.** `OpenQuestionPending_QeM` filters
  on `AnsweredAt` being unset, while the Runtime's `isAnswered` counts *any* filled answer field —
  and nothing stamps the timestamp, so a User who answers and saves leaves a row that still looks
  pending. This change doubles the number of questions a booking raises, so it doubles the residue.
  Fixing it means widening the query model's constraint to all four answer fields, which needs the
  `undefined_match`-on-a-Boolean behaviour verified against the live store first. The e2e page object
  now disambiguates by prompt instead of assuming one row per Conversation.
- **`READABLE_MODELS` in `runtime/src/tools/tools.ts` is dead.** Unused before this change and
  untouched by it.
