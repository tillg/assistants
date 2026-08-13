# Architecture — how the three are built

Three sections. **A, B and C are independent of each other**, and any of them may ship alone.

---

## A — An Operation may require an approval (#1)

### The shape

`ToolDefinition` gains two optional fields:

```ts
export interface ToolDefinition {
    name: string;
    // …
    mutating: boolean;
    /** This Operation refuses to run without an approval for these exact arguments. */
    requiresApproval?: boolean;
    /** How the approval question reads to the User. Falls back to a JSON block. */
    describeCall?(args: Record<string, unknown>): string;
}
```

`bookkeeping.postTransaction` sets both. Nothing else does today, and `bookkeeping.createAccount`
would if it were ever granted.

**The Manual Connectors do not, and must not.** `bank.sendMoney`, `email.send` and
`document.requestText` already suspend with `waitingFor: "tool"` and an Open Question: the User
*performs* them by hand. An approval there would ask the User to approve doing something they are
about to be asked to do themselves.

### What an approval is

An approval is an answered Open Question with `kind: "confirm"` and `confirmed: true` that the
**Runtime** raised for this Operation with **these arguments**, in this Conversation, and that no
earlier call has already consumed.

**Rejected: any answered `confirm` counts.** It was the first draft, and it is unsound. A model that
asks *"shall I file this under Renovation?"*, is told yes, and then calls `postTransaction` with any
arguments it likes would have been authorised by a yes about something else. A question the Assistant
composed cannot be the thing that constrains the Assistant.

The consequence, accepted: an Assistant that asks politely of its own accord is not thereby
authorised, so **every first booking costs one suspend/resume round trip**. It is one Turn, and it
buys a User who sees the exact arguments they are approving.

### Binding to the arguments

The arguments arrive as the model produced them, so key order is not stable and neither is number
formatting. The hash is taken over a **canonical** form — keys sorted, numbers normalised — and stored
as `argsHash`.

The model must then re-issue the call after the yes, and nothing forces it to re-issue *identical*
arguments. A rounded amount or an added optional field misses the approval, and the User is asked a
second, near-identical question. That is the accepted failure mode: **visible and safe**, never a
wrong booking.

**Rejected: the Runtime replays the approved arguments itself** when the answer arrives. It is
strictly stronger — drift becomes impossible and the model cannot substitute anything — and it is
rejected anyway, because it makes the Runtime an actor that posts bookkeeping entries on its own
initiative. That is a larger change to what the Runtime *is* than this item is worth, and it breaks
the discipline that `reconcile` never re-executes. Drift is cheap to observe; a Runtime that books is
not cheap to reason about.

### How it is recognised in the transcript

`Entry` today carries no `questionId`, no question `kind` and no `confirmed` — an answer reaches the
transcript as `role: "user", kind: "answer"` with the output of `renderAnswer()` in `text`. So the
walk-back needs something machine-readable, and **the prose is never parsed**: substring-matching a
model-facing string is the Selma failure mode
[the comparison document](../../research/ASSISTANTS_VS_OPENCLAW.md) names as a thing never to start
doing.

Two additions, both small:

- **`Entry.questionId`**, set by the watcher's answered-question scan on the `answer` entry it appends.
  Every answer gets it; only approvals read it.
- **A `kind: "approval-request"` Entry**, written by the Runtime when it raises the question, carrying
  `toolName`, the `argsHash` and the `questionId`.

The predicate then walks back over two structured Entry kinds and reads one Open Question by id:

```
find the last approval-request for (toolName, argsHash)
  → no such request                                       → refuse, and raise one
  → its answer entry is absent                            → refuse (still waiting)
  → its question has confirmed: false                     → decline (terminal, see below)
  → a tool-result carrying this argsHash follows the answer → refuse, consumed
  → otherwise                                             → execute
```

**Corrected while building.** This predicate first read *"a tool-result for this Operation follows
the answer → consumed"*, and that is wrong on the most ordinary path there is. Every refusal and
every rejection is recorded as a `tool-result` for the Operation, so a Firefly 422 — after which
nothing whatsoever was booked — consumed the approval, and a model retrying the identical call as
`postTransaction`'s own description invites it to ("Safe to retry") got the User asked a second time.
That is the question-per-retry the mechanism exists to bound.

**Spent means executed, not attempted.** The `argsHash` is therefore written onto the *tool-result*
as well, and only where the Operation ran and returned a **value** — including on the reconciliation
path, where a call that turns out to have landed spends its approval exactly as an ordinary one does.
A refusal and a rejection leave the approval intact; a booking that succeeded consumes it, so two
identical bookings still need two approvals ([ADR-0012](../../../docs/adr/0012-a-conversation-is-an-intent-log.md)).
Reading a structured field is also what keeps the promise that **the prose is never parsed** — the
alternative was sniffing the result text for `Error:`.

**Rejected: structured answer fields on `Entry`** (`confirmed`, `choice`). It would save one read and
put a copy of a fact next to its Authority, which is
[ADR-0006](../../../docs/adr/0006-one-authority-per-fact.md). One `get` per approval check is nothing.

### Where the check goes

In `advance()`, in the tool-call loop, **after** the intent is appended and written and **before**
`tools.execute`. That position is not incidental:

- The intent is already in the transcript, so a refusal is visible in the Conversation rather than
  inferred from its absence.
- It is the same place a `pending` outcome is handled, so the refusal path is the existing path.

### What a refusal does

It raises the approval question and returns `{ kind: "pending", waitingFor: "user" }`. The model does
not have to know the rule: an Assistant whose prompt forgot to ask still cannot book — it simply gets
asked on the model's behalf and is resumed with the answer.

Three details that are easy to get wrong:

- **It uses `raiseQuestion` directly, never `escalate()`.** A missing approval is the ordinary path,
  not a stuck Conversation. Going through `escalate()` would increment `escalationCount`, and three
  unapproved bookings would mark the Conversation `failed`.
- **The pending tool-result's note must say *refused pending approval, not queued*.** The generic
  wording — *"Suspended; the answer will arrive as a later message"* — would tell the model its
  booking is on its way. It is not; the model has to call again.
- **No `wakeAt`**, following `ui.askUser`. An unanswered approval waits; it does not lapse into a
  booking.

**Rejected:** returning `{ kind: "error" }`. It would let the next Turn retry, and a model that retries
an approval refusal is a model burning Turns against a wall. Pending is what suspension is for.

**Rejected:** a `requiresApproval` grant on the *Assistant* rather than the Operation. It would make
the safety property per-Assistant configuration — exactly the "probabilistic" arrangement ADR-0010
rejected, one level up.

### A no is terminal

`isAnswered()` treats `confirmed: false` as answered, so a no resumes the Conversation. The retry then
gets `{ kind: "error", message: "The User declined this booking." }` — an ordinary tool result the model
can self-correct against — and **no second question is raised** for that `(operation, argsHash)`.
Without this, a model that retries and a User who keeps saying no produce a question per retry, capped
only by `maxTurns`.

A model that changes the arguments after a no gets a fresh question, because it is a different call.
That is the correct reading, and it is bounded by `maxTurns`.

### How the question reads

Through `describeCall`, because this question is the entire user-facing surface of *"nothing is booked
without an answer"*. `postTransaction` renders

> **Approval needed.** Book €96.50 from *Chequing* to *Renovation*, dated 2026-08-12, for invoice
> INV-233?

and an Operation without a `describeCall` falls back to the Operation name and a fenced JSON block.
The fallback exists so the check never blocks on a missing renderer; it is not the intended
experience. A JSON blob in the inbox is how a safety feature becomes a thing the User clicks yes on
without reading, and there is exactly one Operation to write a renderer for.

### Test

The one that matters is a scripted transcript in which the model calls `postTransaction` **without an
approval**, asserting that nothing reaches Firefly and an Open Question appears. That test fails
today. Then the three refusal cases: no request at all, an explicit `confirmed: false`, and an
approval already consumed by a previous call.

The **existing end-to-end fixture must be re-scripted.** Its model asks before booking, and that ask
no longer counts, so the transcript gains a refusal, a question and a resume. That it must change is
the demonstration that it was previously proving the model's manners rather than the rule.

---

## B — The seventh scan, and a schedule that is quiet when idle (#2, #7, #11)

### The scan ([ADR-0016](../../../docs/adr/0016-a-schedule-fires-on-its-due-instant.md))

`Conversation_DM` gains an indexed `scheduledFor` beside `subjectThingId`, plus its form-model field
([ADR-0008](../../../docs/adr/0008-every-data-model-has-a-form-model.md)). Codes not enumerations, per
`import/models/CONVENTIONS.md`; the value is a canonical UTC ISO-8601 instant so `exact_match` works.

Scan 7, for each enabled Assistant carrying a `schedule` Trigger:

```
due = latestDueInstantBefore(now, trigger.cron, SCHEDULE_TIMEZONE)   # resolved to UTC
if due is undefined:                                      continue   # never yet due
if conversationExistsFor(assistantKey, scheduledFor=due):  continue   # already served
if anyUnfinishedScheduledConversation(assistantKey):       continue   # the skip rule
birth(assistant, scheduledFor=due, idempotencyKey=`birth:${key}:${due}`)
```

Only the *latest* due instant is ever evaluated, which is what makes catch-up-once fall out of the
mechanism rather than out of extra code. `TRIGGER_ELIGIBLE_MODELS` is not consulted — there is no
subject Model — and every other bound is: `paused` short-circuits the whole scan already, the
births-per-hour cap applies, `enabled` gates the Assistant.

`latestDueInstantBefore` wraps **`cron-parser`** with its `tz` option and walks backwards from now.
Hand-rolling cron-with-daylight-saving is a bad trade; what the wrapper owns is the two decisions
ADR-0016 made — the doubled autumn hour resolves to one instant and fires once, the missing spring hour
resolves to nothing and does not fire — and those are what its tests point at. A new runtime dependency
in a repository that pins its artefacts (D-006) is named here rather than slipped in.

A cron expression that does not parse is a configuration error on a Thing the User owns, so it is
logged and the Trigger is skipped. "Once per Assistant" lives in an in-memory `Set<assistantKey>` on
the watcher, so it means **once per process** — persisting it would put a logging detail in the store,
and a restart re-logging a genuine misconfiguration is a feature rather than a leak.

It does not disable the Assistant. **Nothing in this change disables an Assistant** — see the
proposal for why the auto-disable this section was originally paired with turned out to have nothing
to count.

### Quiet by construction (#7)

No mechanism. A scheduled Conversation that finds nothing to do reaches `finishReason: answered` with a
short result and no Open Question — which
[ADR-0015](../../../docs/adr/0015-nothing-ends-silently.md) already permits, because nothing failed.
What is needed is that the *prompt* says so, so the birth prompt for a scheduled Conversation ends with
a sentence to that effect, and the seeded Assistant that first carries a schedule gets a Skill saying
it.

The cost is one cheap Conversation per firing, which is the honest floor: the Assistant has to look
before it can know there is nothing to do. A daily schedule is a Conversation a day. An hourly one is a
design mistake, and the births-per-hour cap is what says so.

**How the User knows a working schedule is alive:** the quiet Conversation *is* the record.
`scheduledFor` is indexed, so *"did Monday's chase run?"* is one query against the Conversations list.
A `lastScheduledRunAt` per Assistant was considered and rejected — it would hold, in a second place, a
fact the Conversations already hold (ADR-0006), and it is the same argument section C makes about not
building a cost store.

**Rejected:** a `HEARTBEAT_OK` token stripped from the reply, as OpenClaw does. It exists to suppress a
*notification*; we have no notification to suppress, because a finished Conversation is already silent.
Importing it would add a magic string to earn nothing.

### The first real schedule, and why its Skill must batch

The Accountant gets a **daily** cron and its existing *"chase what is unpaid"* Skill, which has never
had a way to run.

Chasing means `email.send`, a Manual Connector: it raises an Open Question and the Conversation waits.
The skip rule then holds every later slot until the User has sent that email by hand. So a chase that
finds three unpaid invoices and asks about them **one at a time stalls the schedule on the first**.

The Skill must therefore gather everything unpaid and raise **one** question covering all of it. This
makes batching a correctness property of a Skill's prose, which is not where anyone looks for one — so
it is written in the Skill, in the plan, and here. The failure mode is quiet in exactly the wrong way:
with nothing unpaid the schedule looks perfect, and it misbehaves the first time it finds two things.

### Stable-first, volatile-last (#11)

`scheduledFor` is the first time-varying value to reach a prompt. The rule we already follow by
accident becomes one written down: the stable half of the system prompt comes first, anything that
changes per Conversation comes last. Free, and it is the sort of thing that is only free before
something breaks it.

---

## C — Token usage on the Turn (#6)

`LlmResponse` gains `usage?: { promptTokens, completionTokens }`. `OpenAiProvider` and
`AnthropicProvider` read the field their APIs already return; `ScriptedProvider` returns zeroes.

**Where it is written is the one real question.** A Turn that ends `wants-tools` appends no `assistant`
Entry at all — only one `tool-intent` per call — so "the Turn's assistant Entry" names a row that does
not exist for most Turns. The rule is therefore: **the first Entry the Turn wrote** — the `assistant`
entry for a text reply, the first `tool-intent` otherwise.

**Rejected:** always appending an `assistant` Entry on a tool Turn (it changes what every provider sees
on every replay); a dedicated `kind: "usage"` Entry (`buildMessages` would have to learn to skip it, or
it reaches the model); and running totals on the Conversation, which contradicts the glossary making
the *Turn* the unit cost is counted in.

**The record is a lower bound, and says so.** Usage exists only where a provider returned a response: a
Turn killed by a thrown `TransientLlmError` produced no response, and a Turn ending
`finishReason: "error"` escalates without appending an assistant Entry at all. Both record nothing.
Chasing usage onto the error paths buys precision nobody will spend; the honest sentence in
`specs/system/domain.md` costs nothing. What must not happen is a document claiming a Conversation
carries what its Turns cost without the caveat.

Nothing aggregates, nothing bills, no dashboard. A Conversation carries what its Turns cost and the
transcript is where you read it — which is [item 5 of the comparison's inspectability
argument](../../research/ASSISTANTS_VS_OPENCLAW.md) applied to itself: the record, not a second store.

---

## Deferred: Open Questions on a messenger (#3)

Not built, and the reasons are in [the proposal](proposal.md). One decision is recorded now, because it
is the one a future implementer will get wrong:

**A channel hooks `raiseQuestion`, not `ui.askUser`.** Every Open Question in the system passes through
`raiseQuestion` — `ui.askUser`, every Manual Connector, every escalation, and now every approval.
`ui.askUser` is the obvious-looking hook and it misses all of those but the first, which is to say it
misses precisely the questions worth pushing to a phone. And the notification must be **non-fatal**:
ADR-0015's rule that the escalation path must not share fate with the failures it reports cuts both
ways, so a dead channel must never fail a Conversation.

This is recorded in [the system architecture](../../system/architecture.md) and against item 3 in the
learnings table, so it is findable without this change's directory.
