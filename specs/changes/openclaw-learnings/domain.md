# Domain — what these five add to the language

Only two of the five touch the vocabulary. The rest are mechanics behind terms that already exist.

## New

**Approval**:
An answered Open Question that a particular Operation requires before it may execute. It is a
property of the **Operation**, not of the Assistant and not of the prompt: an Operation either
requires one or does not, and the Runtime refuses the call when it is missing. The Open Question
itself is unchanged — an ordinary `confirm`, asked and answered the ordinary way. What is new is
that something now *checks*.
_Avoid_: permission, sign-off, confirmation gate, four-eyes

**Notification Connector**:
A Connector whose External System is a place the User can be reached, and whose Operations carry an
Open Question out and an answer back. It is not a channel in OpenClaw's sense and there is no
gateway: it renders a Thing and returns a reply, exactly as a Manual Connector asks a human to do
something and report back. Whether the User answered in the web application or on a phone is
invisible to the Assistant.
_Avoid_: channel, adapter, gateway, bot

## Sharpened

**Schedule** *(already in CONTEXT.md)* — gains two properties it did not have:

- A Schedule **catches up once**, never once per missed slot
  ([ADR-0016](../../../docs/adr/0016-a-schedule-fires-on-its-due-instant.md)).
- A Schedule that fails repeatedly **disables its Assistant**. `enabled` already exists and stops
  births and continuations alike; what is new is that something sets it.

**Turn** *(already in CONTEXT.md)* — its definition already says "the unit in which cost is
counted". After item 6 that is true rather than aspirational: a Turn carries what the model charged
for it.

## Rules this change adds

### An Operation that requires approval cannot execute without one

The check is on the **Operation**, evaluated by the Runtime, in the same place the intent is
written. Three consequences follow from putting it there rather than in a prompt:

- An Assistant cannot talk its way past it, because it is not asked.
- It composes with the pending path: a missing approval is not an error, it is an Operation that
  cannot complete yet — so the Conversation suspends and the question is raised, which is the path
  the loop already has.
- Reading an Operation tells you whether it needs an answer, the same way reading an Assistant
  tells you what it may reach ([ADR-0010](../../../docs/adr/0010-assistants-declare-their-tools.md)).

### An approval belongs to a Conversation, not to a Thing

The approval that satisfies `bookkeeping.postTransaction` is an answered Open Question **in the
Conversation making the call**. Not an approval of the Invoice, and not a standing approval of the
Assistant. This keeps [ADR-0006](../../../docs/adr/0006-one-authority-per-fact.md) intact — no
`approved` field appears on any Thing — and it means a second Conversation about the same Invoice
must ask again, which is correct: it is a different piece of work.

### Sending an Open Question outward does not move its Authority

The ThingStore remains the Authority for an Open Question and its answer. A Notification Connector
that posts one to a messenger is showing a copy; the answer it brings back is written to the
ThingStore before it counts. Nothing is answered because a message was sent.
