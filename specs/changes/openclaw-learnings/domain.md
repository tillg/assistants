# Domain — what this change adds to the language

One new term, two sharpened. The rest is mechanics behind terms that already exist.

## New

**Approval**:
A property of an **Operation**: it either requires one or does not, and the Runtime refuses the call
when it is missing. What satisfies it is an answered confirmation, raised by the **Runtime** rather
than by the Assistant, bound to that Operation and to the arguments it was asked with — so a yes to
one thing cannot authorise another, and an Assistant cannot talk its way past a check it is never
asked about. Not a kind of Open Question: the question is the ordinary form, asked and answered the
ordinary way. What is new is that something now *checks*.
_Avoid_: permission, sign-off, confirmation gate, four-eyes

The term collided with the glossary on arrival — `CONTEXT.md` listed *approval* among the words never
to use for an Open Question. The ban is narrowed rather than lifted: calling an Open Question an
approval is still wrong, because an approval is something an Operation **requires**, not something
the User is sent.

## Sharpened

**Schedule** *(already in CONTEXT.md)* — a standing instruction about the current state of the
world, not an event log ([ADR-0016](../../../docs/adr/0016-a-schedule-fires-on-its-due-instant.md)):

- A Schedule **catches up once**, never once per missed slot.
- A slot is **skipped entirely while the previous one is unfinished**, so a Schedule **stalls rather
  than accumulates**.

The second property is why this change contains no auto-disable. A Schedule cannot run away, so
there is no runaway to bound; what it can do is stall, and a stall already has an Open Question
attached to it.

**Turn** *(already in CONTEXT.md)* — its definition already says "the unit in which cost is counted".
After item 6 that is true rather than aspirational: a Turn carries what the model charged for it —
with one honest limit, that a Turn which errored carries nothing, so the Turns of a Conversation sum
to a **lower bound** on its cost rather than to its cost.

## Rules this change adds

### An Operation that requires an approval cannot execute without one

The check is on the **Operation**, evaluated by the Runtime, in the same place the intent is written.
Three consequences follow from putting it there rather than in a prompt:

- An Assistant cannot talk its way past it, because it is not asked.
- It composes with the pending path: a missing approval is not an error, it is an Operation that
  cannot complete yet — so the Conversation suspends and the question is raised, which is the path
  the loop already has.
- Reading an Operation tells you whether it needs an answer, the same way reading an Assistant tells
  you what it may reach ([ADR-0010](../../../docs/adr/0010-assistants-declare-their-tools.md)).

### Only the Runtime can raise an approval, and it approves exact arguments

An Assistant asking *"shall I book this?"* of its own accord is good manners and nothing more. It
does not satisfy anything, because a question the Assistant composed is a question the Assistant
could have composed differently. The approval is bound to the Operation **and** to the arguments the
call was made with, so a yes cannot travel from the call it was asked about to another one.

### An approval belongs to a Conversation, and is consumed by the call it approves

The approval that satisfies `bookkeeping.postTransaction` is an answered question **in the
Conversation making the call**. Not an approval of the Invoice, and not a standing approval of the
Assistant. This keeps [ADR-0006](../../../docs/adr/0006-one-authority-per-fact.md) intact — no
`approved` field appears on any Thing — and it means a second Conversation about the same Invoice
must ask again, which is correct: it is a different piece of work.

It is consumed once used. Two identical bookings therefore need two approvals — the alternative
would let one yes place the same transaction twice under two idempotency keys, which is what
[ADR-0012](../../../docs/adr/0012-a-conversation-is-an-intent-log.md) exists to prevent.

### A no is an answer, not a missing yes

A declined approval is **terminal for that Operation with those arguments** in that Conversation. The
Assistant is told plainly that the User declined, as an ordinary tool error it can act on, and it is
not asked again. Re-asking a User who has said no is how a safety feature becomes a thing people
click through.

### Nothing needs to be said when there was nothing to do

A scheduled Conversation that finds no work finishes with a short result and no Open Question.
[ADR-0015](../../../docs/adr/0015-nothing-ends-silently.md) requires noise when something *failed*,
and nothing failed. The Conversation itself is the record that the slot was served — which is also
the answer to "how do I know it ran": `scheduledFor` is indexed, so it is one query, not a second
store.
