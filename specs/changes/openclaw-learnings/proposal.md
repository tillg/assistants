# Proposal — the five learnings worth building

## What

Five items adopted from [ASSISTANTS_VS_OPENCLAW.md](../../research/ASSISTANTS_VS_OPENCLAW.md), numbered
as they are in that document's learnings table:

| # | Item | Why it is here |
|---|---|---|
| **1** | An Operation may **require an answered Open Question** before it executes | The system's central promise is enforced by a prompt today |
| **6** | **Token usage recorded on the Turn** | `CONTEXT.md` calls the Turn "the unit in which cost is counted" and nothing counts |
| **5** | A **Schedule that keeps failing disables itself** | An unattended clock with no off switch is the runaway bound |
| **7** | A **scheduled Conversation that finds nothing is quiet** | Otherwise proactivity is a Conversation per firing, for ever |
| **3** | **Open Questions reachable on a messaging channel** | The whole value is a question getting answered; today that needs a browser on localhost |

They are independent. This is one change for traceability, not because they are one feature — the
plan is grouped so any group can ship alone, and splitting it into four changes costs nothing but
directories.

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
It stopped one step short. This change takes that step.

**Items 5 and 7 are the cost of proactivity.** [ADR-0016](../../../docs/adr/0016-a-schedule-fires-on-its-due-instant.md)
settles how a Schedule Trigger stays exactly-once; it does not settle what a schedule does when it
finds nothing, or when its Authority has been down for a week. Without both, the first useful
schedule produces either an Open Question per firing or a bill per firing.

**Item 6 is two fields.** Both providers already receive `usage` and drop it.

**Item 3 is the difference between a two-second answer and a three-day one.** It is last because it
is the only one that adds an External System.

## Scope

- A Tool may declare that it requires approval, and the Runtime refuses it without one.
- The Turn records what it cost.
- The seventh watcher scan, implementing ADR-0016 — a prerequisite for 5 and 7, not a separate item.
- A Schedule disables its Assistant after repeated failure, and finishes quietly when there is
  nothing to do.
- One messaging Connector that carries an Open Question out and an answer back.

## Non-goals

- **No gateway, no channel abstraction, no session routing.** A channel is a Connector
  ([ADR-0011](../../../docs/adr/0011-the-runtime-polls-the-thingstore.md) is untouched). One
  Connector, not a framework — the second channel is when an abstraction gets designed, if ever.
- **No compaction, forking or steering.** Still deliberately absent.
- **No memory subsystem.** Item 11 of the comparison's strengths list is that we have none, and
  that stays true.
- **No approval UI.** An approved Open Question is the ordinary form, saved.
- **Not a general policy engine.** Item 1 is one boolean on an Operation, not rules.

## Risks

- **Item 1 changes behaviour the fixtures encode.** The scripted transcript books after asking, so
  it should keep passing — but a fixture that ever books without asking will now fail, and that is
  the point. Any failure it causes is a bug it found.
- **Item 3 touches the single-writer rule.** [ADR-0014](../../../docs/adr/0014-exactly-one-runtime-replica.md)
  gives the Open Question one writer after creation, the User. The Connector must not become a
  second Runtime writer on that document. Settled in the architecture; it is the only genuinely
  open design question in this change.
- **Item 3 sends household data to a third party**, which nothing in this system does today
  (*"nothing leaves the machine except calls to the configured LLM API"*). That sentence in the
  README stops being true, and the change must say so rather than quietly invalidate it.
