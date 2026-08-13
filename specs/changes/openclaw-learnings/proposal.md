# Proposal — three learnings worth building, and two that turned out not to be

## What

Adopted from [ASSISTANTS_VS_OPENCLAW.md](../../research/ASSISTANTS_VS_OPENCLAW.md), numbered as they
are in that document's learnings table:

| # | Item | Why it is here |
|---|---|---|
| **1** | An Operation may **require an approval** before it executes | The system's central promise is enforced by a prompt today |
| **6** | **Token usage recorded on the Turn** | `CONTEXT.md` calls the Turn "the unit in which cost is counted" and nothing counts |
| **2** | The **seventh scan**, implementing [ADR-0016](../../../docs/adr/0016-a-schedule-fires-on-its-due-instant.md) | A Schedule Trigger is a field name, and six documents say so |
| **7** | A **scheduled Conversation that finds nothing is quiet** | Otherwise the first useful schedule is an Open Question per firing |
| **11** | The system prompt stays **stable-first, volatile-last** | Free, and item 2 is the first thing to put a varying instant into a prompt |

Items 1 and 6 are independent of everything. Items 2, 7 and 11 are one piece of work: 7 is a
sentence in a prompt that has nowhere to live until 2 exists, and 11 is the rule that keeps 2 from
spoiling the stable half of the prompt.

**Two items were dropped during the grilling, and that reasoning is the more valuable half of this
change.** Item 5 (auto-disable a failing Schedule) and item 8 (active hours) turned out to be
unreachable given ADR-0016 — see *What the grilling removed*. Item 3 (Open Questions on a messenger)
is deferred whole, but the seam it would attach to is recorded, so that it is not chosen wrongly
later.

## Why

**Item 1 is the reason this change exists.** The README's second paragraph ends *"Nothing is booked
without an answer."* That sentence is currently kept by the Accountant's system prompt —
*"Never book without an explicit yes"* — and by nothing else. `bookkeeping.postTransaction` is
granted and callable on any Turn. [ADR-0012](../../../docs/adr/0012-a-conversation-is-an-intent-log.md)
guarantees the same booking cannot land twice; nothing guarantees a *first* booking was approved.
The end-to-end tier scripts a model that chooses to ask, so it proves suspend-and-resume, not the
rule.

[ADR-0010](../../../docs/adr/0010-assistants-declare-their-tools.md) already made the argument in
the general case: *"A prompt saying 'never send money' is probabilistic; a declaration is not."*
It stopped one step short. This change takes that step — and takes it one further than first
drafted: the approval must be one the **Runtime** raised, bound to the Operation *and the arguments
it was asked with*. An approval that any answered `confirm` could satisfy would have let a yes to
*"shall I file this under Renovation?"* authorise a booking of any amount, which is the same
probabilistic arrangement moved one level down.

**Item 6 is two fields.** Both providers already receive `usage` and drop it.

**Items 2, 7 and 11 are the cost of proactivity, and it is smaller than expected.** ADR-0016 settles
how a Schedule Trigger stays exactly-once but not what a schedule does when it finds nothing;
without 7, the first useful schedule produces an Open Question per firing. What 7 needs is a
sentence, not a mechanism: a finished Conversation is already silent, because
[ADR-0015](../../../docs/adr/0015-nothing-ends-silently.md) demands noise only when something
failed.

## What the grilling removed

**Items 5 and 8 — a Schedule that disables itself, and active hours.** `status = "failed"` is set in
exactly one place in the Runtime, and only once a Conversation has been escalated more than
`maxEscalations` times — which requires the User to have answered every escalation. ADR-0015 says as
much: `failed` means *the User abandoned it*. Every other way a scheduled Conversation can go wrong
— an LLM error, a tool error, `maxTurns`, an unreconcilable intent — ends `waiting` on an Open
Question, and ADR-0016 **skips the next slot while the previous one is unfinished**. So a Firefly
that has been down for a week produces one stalled Conversation and one question, not five firings.

There is no sequence of consecutive failures for a threshold to observe. The runaway that
auto-disable was adopted against was converted into a *stall* by the very decision it was adopted
alongside. OpenClaw needs auto-disable because its schedule fires regardless of what the last firing
did; ours cannot. Item 8 goes for the same reason, plus `enabled`, which already exists and is
already the kill switch.

Re-aiming item 5 at the stall was considered and rejected: the stall exists *because* there is an
unanswered Open Question, so a second question about the first is noise, and ADR-0016 deliberately
made repeated skipping a log warning rather than a question.

**Item 3 — Open Questions on a messenger.** Deferred whole. It was the only item adding an External
System, the only one colliding with [ADR-0014](../../../docs/adr/0014-exactly-one-runtime-replica.md)'s
single-writer rule, and the only one that would have made the README's *"nothing leaves the machine
except calls to the configured LLM API"* false. What is kept is one decision, recorded in
[the system architecture](../../system/architecture.md) and against item 3 in the learnings table:
notification hooks **`raiseQuestion`**, the choke point every Open Question already passes through,
and it must be non-fatal. Not `ui.askUser` — which is the obvious-looking hook, and which misses
every escalation, every Manual Connector and every approval, in other words precisely the questions
worth pushing.

## Scope

- A Tool may declare that it requires an approval; the Runtime refuses it without one and raises the
  approval question itself.
- The Turn records what the model charged for it.
- The seventh watcher scan, implementing ADR-0016, with one seeded Assistant actually scheduled.
- A scheduled Conversation that finds nothing finishes quietly, by convention rather than mechanism.

## Non-goals

- **No messenger, no gateway, no channel abstraction, no session routing.** Deferred entire; the
  seam is recorded and nothing else. [ADR-0011](../../../docs/adr/0011-the-runtime-polls-the-thingstore.md)
  is untouched.
- **No auto-disable and no active hours.** Argued out above, not postponed.
- **No compaction, forking or steering.** Still deliberately absent.
- **No memory subsystem.** Item 11 of the comparison's strengths list is that we have none, and that
  stays true.
- **No approval UI.** An approval question is the ordinary form, saved.
- **Not a general policy engine.** Item 1 is one boolean on an Operation, not rules.
- **Nothing aggregates token usage.** No dashboard, no billing, no second store.

## Risks

- **Item 1 breaks the end-to-end fixture, and that is the point twice over.** The scripted invoice
  slice has the model ask before booking — but a model-authored `confirm` no longer counts as an
  approval, so that transcript now gains a refusal, an approval question and a resume. The fixture
  must be re-scripted, and the fact that it must is the demonstration that the old one was proving
  the model's good manners rather than the rule.
- **Item 1 costs a round trip on every first booking.** Accepted deliberately: it is one Turn, and
  it buys a User who always sees the exact arguments they are approving.
- **An approval can be missed by argument drift.** The model re-issues the call after the yes, and
  nothing forces it to re-issue *identical* arguments. A drifted call misses its approval and asks
  again. Visible and safe — a second question, never a wrong booking — but it will be seen.
- **The first real schedule stalls if its Skill does not batch.** A chase that asks about three
  unpaid invoices one at a time stalls the schedule on the first, because of the skip rule. That
  makes batching a correctness property of a Skill's prose, which is not where anyone looks for one.
- **The recorded cost is a lower bound.** A Turn that errored records no usage, by construction. The
  documentation must say so rather than implying that a Conversation's Turns sum to what it cost.
