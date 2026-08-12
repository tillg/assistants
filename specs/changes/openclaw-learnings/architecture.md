# Architecture — how the five are built

Ordered by dependency, not by importance. Groups A, B and D are independent of each other; C
depends on B.

---

## A — An Operation may require an answered Open Question (#1)

### The shape

`ToolDefinition` gains one field:

```ts
export interface ToolDefinition {
    name: string;
    // …
    mutating: boolean;
    /** This Operation refuses to run without an answered Open Question in the calling Conversation. */
    requiresApproval?: boolean;
}
```

`bookkeeping.postTransaction` sets it. Nothing else does today, and
`bookkeeping.createAccount` would if it were ever granted.

### Where the check goes

In `advance()`, in the tool-call loop, **after** the intent is appended and written and **before**
`tools.execute`. That position is not incidental:

- The intent is already in the transcript, so a refusal is visible in the Conversation rather than
  inferred from its absence.
- It is the same place a `pending` outcome is handled, so the refusal path is the existing path.

### What counts as an approval

Walking back through the Conversation's entries from the current position, an approval is an
`answer` entry whose Open Question was `kind: "confirm"` and `confirmed: true`, appearing **after
the most recent `tool-result` for this same Operation**. The last clause is what stops one yes
authorising every subsequent booking in a long Conversation: an approval is consumed by the call it
approves.

The rule for the ambiguous cases, chosen deliberately:

| Situation | Outcome |
|---|---|
| No answered `confirm` in this Conversation | refuse |
| Answered `confirm`, `confirmed: false` | refuse — a no is not a missing yes |
| Answered `confirm` already consumed by an earlier call to this Operation | refuse |
| Answered `confirm`, unconsumed | execute |

### What a refusal does

It returns `{ kind: "pending", waitingFor: "user" }` and raises the Open Question itself, with a
prompt naming the Operation and its arguments. So the model does not have to know the rule, and an
Assistant whose prompt forgot to ask still cannot book — it simply gets asked on the model's behalf,
and is resumed with the answer. This is the pending path from
[the loop](../../../specs/system/architecture.md), unchanged.

**Rejected:** returning `{ kind: "error" }`. It would let the next Turn retry, and a model that
retries an approval refusal is a model burning Turns against a wall. Pending is what suspension is
for.

**Rejected:** a `requiresApproval` grant on the *Assistant* rather than the Operation. It would
make the safety property per-Assistant configuration — exactly the "probabilistic" arrangement
ADR-0010 rejected, one level up.

### Test

The one that matters is a scripted transcript in which the model calls `postTransaction` **without
asking first**, asserting that nothing reaches Firefly and an Open Question appears. That test
fails today.

---

## B — The seventh scan (prerequisite; [ADR-0016](../../../docs/adr/0016-a-schedule-fires-on-its-due-instant.md))

`Conversation_DM` gains an indexed `scheduledFor` beside `subjectThingId`, plus its form-model
field ([ADR-0008](../../../docs/adr/0008-every-data-model-has-a-form-model.md)). Codes not
enumerations, per `import/models/CONVENTIONS.md`; the value is a canonical UTC ISO-8601 instant so
`exact_match` works.

Scan 7, for each enabled Assistant carrying a `schedule` Trigger:

```
due = latestDueInstantBefore(now, trigger.cron, SCHEDULE_TIMEZONE)   # resolved to UTC
if due is undefined:                                  continue      # never yet due
if conversationExistsFor(assistantKey, scheduledFor=due): continue  # already served
if anyUnfinishedScheduledConversation(assistantKey):   continue      # group C
birth(assistant, scheduledFor=due, idempotencyKey=`birth:${key}:${due}`)
```

Only the *latest* due instant is ever evaluated, which is what makes catch-up-once fall out of the
mechanism rather than out of extra code. `TRIGGER_ELIGIBLE_MODELS` is not consulted — there is no
subject Model — and every other bound is: `paused` short-circuits the whole scan already, the
births-per-hour cap applies, `enabled` gates the Assistant.

A cron expression that does not parse is a configuration error on a Thing the User owns, so it is
logged once per Assistant and the Trigger is skipped. It does not disable the Assistant: that is
group C's job and it is about failing *work*, not malformed configuration.

---

## C — A Schedule that fails disables itself, and says nothing when idle (#5, #7)

### Quiet by construction (#7)

No mechanism. A scheduled Conversation that finds nothing to do reaches `finishReason: answered`
with a short result and no Open Question — which
[ADR-0015](../../../docs/adr/0015-nothing-ends-silently.md) already permits, because nothing
failed. What is needed is that the *prompt* says so, so the birth prompt for a scheduled
Conversation ends with a sentence to that effect, and the seeded Assistant that first carries a
schedule gets a Skill saying it.

The cost is one cheap Conversation per firing, which is the honest floor: the Assistant has to look
before it can know there is nothing to do. A daily schedule is a Conversation a day. An hourly one
is a design mistake, and the births-per-hour cap is what says so.

**Rejected:** a `HEARTBEAT_OK` token stripped from the reply, as OpenClaw does. It exists to
suppress a *notification*; we have no notification to suppress, because a finished Conversation is
already silent. Importing it would add a magic string to earn nothing.

### Auto-disable (#5)

`Assistant` gains `consecutiveScheduleFailures`. It is incremented when a scheduled Conversation
ends `failed` or reaches its third escalation, reset to zero by any scheduled Conversation that
ends `done`, and at a threshold (five) the Runtime sets `enabled = false`.

One problem, and it is the reason this needs care rather than a counter: **the Runtime holds no
`ASSISTANT_WRITE`** (D-007a) — deliberately, so an Assistant cannot grant itself a Tool. It
therefore cannot write `enabled` either.

Two ways out, and the second is chosen:

1. Grant the Runtime a narrow write on those two fields. Rejected: A12's `MODIFY_DOCUMENT` is a
   whole-document replace, so "narrow" is a fiction — the right would be write access to the
   Assistant, which is precisely what D-007a removed.
2. **Keep the counter on `RuntimeState`**, which the Runtime owns outright, as a small map of
   `assistantKey → consecutive failures`. Scan 7 skips an Assistant whose count is at the
   threshold, and raises **one** Open Question saying the schedule has been suspended and why.
   Re-enabling is the User clearing it — which they do by answering that question, since the
   Runtime owns the counter and can clear it on the answer.

So the suspension is real, it is visible in the one place the User already looks, and no
authorisation boundary moves. `Assistant.enabled` keeps its meaning: something the User sets.

---

## D — Token usage on the Turn (#6)

`LlmResponse` gains `usage?: { promptTokens, completionTokens }`. `OpenAiProvider` and
`AnthropicProvider` read the field their APIs already return; `ScriptedProvider` returns zeroes.
`advance()` writes them onto the `assistant` Entry it appends for the Turn.

Nothing aggregates, nothing bills, no dashboard. A Conversation carries what its Turns cost and the
transcript is where you read it — which is [item 5 of the comparison's inspectability
argument](../../../ASSISTANTS_VS_OPENCLAW.md) applied to itself: the record, not a second store.

---

## E — Open Questions on a messenger (#3)

### The shape

A **Notification Connector** — one External System, reached the way Firefly is, with the
Assistants none the wiser.

The push half is easy and is an Operation like any other. **The return half is the whole design
problem**, and it is the ADR-0014 collision the proposal flags: an Open Question has exactly one
writer after creation, the **User**, and a Connector living inside the Runtime writing the answer
onto that document would be a second Runtime write to a document the User may be editing — the
precise hazard that moved answer *consumption* onto the Conversation.

Three options were considered:

1. **The Connector authenticates as the User** and writes the answer as them. Honest about who
   answered, and it keeps the single-writer rule literally true. Costs a stored user credential in
   the Runtime, which `.env` can hold but which makes the Runtime able to act as the human — a
   larger grant than anything it has today.
2. **The reply becomes an Entry on the Conversation**, which the Runtime owns exclusively. No new
   credential, no writer conflict. But the Open Question then shows unanswered for ever in the web
   application while the Conversation has moved on, which is two truths about one question — and
   the Open Questions list is the User's inbox, so corrupting it is not a small cost.
3. **The Connector is a separate process authenticating as the User**, outside the Runtime. Clean
   on paper; a second deployable and a second thing to operate, for one household.

**Chosen: 1.** The single-writer rule is load-bearing and option 2 breaks the inbox, which is the
feature everything else exists to serve. The credential cost is real and is confined: the Connector
gets its own Keycloak user in the `user` role — *a* human identity, not *the* Runtime's, and not
`admin` — so `__meta.creator` still distinguishes it, and the blast radius is what one household
member can do.

### What must be true before it ships

- The stack sends nothing outward today. The README's *"nothing leaves the machine except calls to
  the configured LLM API"* becomes false, and this change updates that sentence rather than
  leaving it to rot.
- An Open Question's text is Assistant-authored and may quote a Document. Sending it to a third
  party sends whatever it quotes. The Connector therefore posts the question and a deep link, and
  **not** the Thing's contents, unless the question itself contains them.
- Inbound text is untrusted, from a channel that authenticates a device rather than a person. It
  is written to the answer field and is read by the model on the next Turn, which is the exposure
  §7 of the comparison is about. It gets the same treatment as any answer and no more trust.

**Deliberately not built:** outbound streaming, message-action vocabulary, group chats, a second
channel, or any abstraction over the first one.
