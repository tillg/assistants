[TOC]

# Agentic Loop — open research questions

The **agentic loop** is what actually executes an Assistant: it watches Triggers, gives birth to Conversations, drives the exchange with the LLM and its tools, and continues Conversations when the actor they were waiting for responds. The concept-level decisions are recorded in [ADR-0004](docs/adr/0004-assistants-suspend-and-resume.md), [ADR-0005](docs/adr/0005-triggers-give-birth-responses-continue.md) and [ADR-0007](docs/adr/0007-assistants-call-each-other-asynchronously.md). This document collects what is *not* decided, to be settled by a dedicated research thread.

The thread should also survey how existing implementations solve these — [Opencode](https://github.com/anomalyco/opencode), [Pi](https://github.com/earendil-works/pi), the Claude Agent SDK — and what concepts they name.

## Q1 — What is the component that runs all this, and what is it called?

Something detects Triggers, materialises inputs into initial prompts, births Conversations, drives the agentic loop and routes responses back into waiting Conversations. It exists in the design and has no name. Unnamed components are where accidental complexity settles.

Working proposal: call it the **`Runtime`**. It is deliberately *not* an External System — External Systems are what Assistants call, whereas this calls Assistants; the arrow points the other way. Scope limited to three jobs: watch Triggers, birth and continue Conversations, drive the loop.

Open: is `Runtime` the right name and the right boundary, or does it decompose (trigger watcher / conversation store / loop driver)?

## Q2 — Is "waiting for X" one state or several?

A Conversation spends most of its life waiting for another actor to respond: the LLM, the User, or a called tool (and, per ADR-0007, another Assistant).

Working proposal: one state with a variant — `waitingFor: llm | user | tool | assistant`. Waiting on the LLM (seconds) and waiting on the User (days) differ in expected duration, not in shape, and treating them alike makes "show me everything that is stuck" a single query. It also means an LLM call that never returns surfaces in the same place as a forgotten question.

Open: does the difference in timescale eventually force different handling (retry policy, visibility, alerting)?

## Q3 — Does the clock give birth, continue, or both?

Two of our own requirements need time, in two different ways:

- *"Chase this claim if it is still unpaid after 30 days"* — nobody is waiting; a Conversation must be **born**.
- *"Watch the clock and ask the called Assistant what is going on after 5 minutes"* (ADR-0007) — a Conversation **is** waiting and must be **continued**.

Working proposal: two distinct concepts. A **schedule** is a Trigger configured on an Assistant (no Conversation exists yet). A **timeout** is state on a waiting Conversation (wake me even if no answer came). Conflating them is tempting and wrong — one is configuration on a template, the other is state on an instance.

Note: a timeout is also what stops a Conversation waiting forever on an Assistant that died, so ADR-0007's "carry on without the result" is unimplementable without it.

## Q4 — `Process`: passive routing slip, or an actor?

`Process` is the most under-specified Thing in the [README](README.md) and the backbone of the construction-permit scenario. Three shapes:

1. **Passive** — a Thing holding what is done and what is outstanding; any Assistant may append; nothing "runs" it.
2. **Owned** — a dedicated Assistant owns each Process and drives it forward.
3. **A Conversation** — the Process *is* one long-running Conversation.

Working proposal: **passive**. Shape 3 contradicts ADR-0004 outright — a permit spans months and no waiting period may be a live process. Shape 2 fails the permit scenario, where the Receptionist (mail arrives), the Accountant (fees) and the User (signatures) all touch the same Process and a single owner would have to broker everything.

Under the passive shape the line is clean: **Conversations are episodes, the Process is the plot.** The Process is durable memory that outlives every Conversation touching it, and a change to a Process is itself a Trigger, so appending a step can wake whoever cares. A standard workflow (processing a doctor's invoice) and an ad-hoc one (obtaining a construction permit) then differ only in whether the Process Model carries a step template.

## Q5 — Is Temporal the right foundation?

Would [Temporal](https://temporal.io/) be the technology to build the loop on? It is worth a serious look because its model matches several decisions we have already made: durable execution that survives restarts, activities that may take days, timers as first-class citizens, and signals that resume a waiting workflow.

Points to examine:

- A Temporal workflow maps naturally onto a Conversation, an activity onto a tool or Connector call, a signal onto the User answering an Open Question, and a timer onto both the schedule and the timeout from Q3.
- But ADR-0004 puts a Conversation's state in the **ThingStore**, whereas Temporal keeps its own event history. That is two Authorities for the same state, which ADR-0006 forbids — so the split has to be worked out deliberately, not inherited.
- Weigh the operational cost (a Temporal cluster) against what it replaces for a single-household system.

---

# Findings — the survey (2026-08-09)

Survey of three implementations: [Opencode](https://github.com/anomalyco/opencode) (read from source, `dev` branch), [Pi](https://github.com/earendil-works/pi) (read from source, `main`, plus the author's [design write-up](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)) and the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/agent-loop.md) (official documentation).

## What the agentic loop is

All three agree on the irreducible core, and Pi's author states it plainest: *processing user messages, executing tool calls, feeding results back to the LLM, and repeating until the model produces a response without tool calls.* As pseudocode:

```
loop:
    context  = build from stored Conversation
    response = LLM(context)                 # streamed
    append response to Conversation
    if response has no tool calls: stop     # the only exit
    for each tool call:
        result = execute(tool call)
        append result to Conversation
```

One iteration — one LLM response plus the execution of its tool calls — is a **turn** in all three systems; the word is worth importing. The loop has no step limit anywhere: it terminates when the model answers without asking for tools (Pi: "the loop just loops until the agent says it's done"; Opencode exits when the finish reason is not `tool-calls` and no tool call is unresolved; the SDK exits on `stop_reason: end_turn`).

Equally telling is what all three agree the loop is *not*: it is not a workflow engine. None of the three has a scheduler, timers, or clock-driven continuation of any kind. All three are born from a human typing a prompt.

## How each one implements it

| | Pi | Opencode | Claude Agent SDK |
|---|---|---|---|
| The loop lives in | `agent-loop.ts`, one ~800-line stateless function | `SessionPrompt.runLoop`, a `while(true)` in a client/server system | `query()`, closed-source binary behind an SDK |
| Loop runner called | `Agent` (wraps the stateless loop) | `SessionPrompt` + a per-session `Runner` | the `query` itself |
| Conversation called | Session | Session | Session |
| Stored as | JSONL file, entries form a **tree** (branching in place) | SQLite rows (session / message / part), every stream delta persisted | JSONL transcript per session |
| Resume after restart | `-c`, `--session <id>`, `--fork` | `--continue`, `--session`, `--fork` | `continue`, `resume: id`, `forkSession` |
| Waiting for the User | loop not running; file is the state | loop not running; runner discarded, status `idle`, DB rows are the state | loop not running; transcript is the state |
| UI coupling | none — UI subscribes to an event stream | none — server publishes SSE events, TUI is just a client | none — caller consumes a message stream |
| Sub-agents | rejected (spawn `pi` via bash instead) | child Session with `parentID`, run by the same loop | isolated context, background by default |
| Tool gating | rejected ("game over anyway" — containerise instead) | per-agent allow/ask/deny rules per Operation | permission modes + allow/deny rules + callbacks |
| Long-context strategy | compaction entries with a retained-tail checkpoint | auto-compaction as a loop step, plus pruning old tool outputs | auto-compaction with a `compact_boundary` marker |

Three convergences stand out because they were reached independently:

1. **The loop is stateless; the store is the truth.** Pi's loop is a pure function over a context snapshot; Opencode writes every delta to SQLite before the UI sees it; the SDK rebuilds everything from the transcript. Restarting is a non-event in all three — exactly ADR-0004, achieved everywhere with a dumb store and a re-entrant loop, never with a workflow engine.
2. **"Waiting for the User" is the absence of a running loop.** In all three, when the turn ends the process holds nothing; a later user message *re-enters* the loop over the stored transcript. Birth and continuation go through the same door (Opencode's `prompt()` both creates and continues; the SDK's `query()` likewise) — which independently confirms ADR-0005's claim that continuation needs no second mechanism, only a stored Conversation to append to.
3. **The durable transcript and the ephemeral event stream are separate.** All three publish fine-grained events (message deltas, tool progress) for UIs to render, but no UI ever reads loop memory — truth is the store, events are a projection. Our UserInterface should attach the same way.

And one warning worth recording: the *only* mid-loop wait for a human that exists in any of the three — Opencode's permission ask — is implemented as an in-memory promise and **does not survive a restart** (pending asks are auto-rejected on shutdown). That is the exact trap ADR-0004 exists to forbid.

## Terms worth importing

- **Turn** — one LLM response plus the execution of its tool calls. The natural unit of persistence, cost accounting and event granularity.
- **Steering / follow-up** (Pi) — a user message injected into a *running* loop before the next turn, versus one delivered only after the loop would have stopped. We get follow-up for free (it is continuation); steering is a refinement we can defer.
- **Part** (Opencode) — a typed fragment of a message: text, reasoning, tool call, tool result, file. The right granularity for the Conversation Model, finer than "message".
- **Finish reason** — why the LLM stopped: done, wants tools, length, error, aborted. The loop's control variable; it belongs in the Conversation, not in code.
- **Fork** (all three) — branching a Conversation from a point in its history. Cheap in every implementation because the transcript is append-only; worth keeping possible in the Conversation Model even if unused at first.
- **Compaction** (all three) — replacing older history with a summary entry when context grows too large, recorded *in* the transcript as its own entry. A months-long permit Conversation will need this; that all three record it as a first-class transcript entry tells us how.

## What this settles for Q1–Q5

**Q1 — settled in favour of decomposition, and `Runtime` survives as the umbrella.** Every implementation separates a *stateless loop driver* from a *conversation store*, and none of them has our third piece — a *trigger watcher* — because all three are born from a human typing. So: the **ThingStore is the conversation store** (already decided), the **loop driver** is a re-entrant function that takes one Conversation one turn forward, and the **trigger watcher** is the genuinely novel component we must design ourselves. `Runtime` names the assembly of trigger watcher and loop driver.

**Q2 — one conceptual state, two implementation regimes.** The survey sharpens the proposal rather than changing it. Waiting on the LLM or on a fast tool happens *inside* a live turn and may live in process memory — it is seconds long, retryable (Opencode wraps it in retry policies) and abortable. Waiting on the User or on another Assistant happens *between* turns, with no process holding anything. `waitingFor: llm | user | tool | assistant` stands as the queryable state, but the rule the survey adds is: **any wait that can outlive a turn must be written to the Conversation before the loop stops.** Opencode's non-durable permission ask shows what happens otherwise. And because our Tools include Manual Connectors, *any* tool wait can outlive a turn — see below.

**Q3 — confirmed by absence.** None of the three has schedules or timeouts; the SDK docs explicitly punt to "the application layer". There is nothing to copy, and nothing contradicting the schedule/timeout split. The trigger watcher grows a clock: it scans for due schedules (birth) and expired `wakeAt` fields on waiting Conversations (continuation).

**Q4 — indirectly supported.** Opencode's background sub-agents finish by injecting their result as a *synthetic user message* into the parent's stored session — a response continuing a Conversation, exactly ADR-0007's shape. Nobody models anything like a Process, which supports keeping it passive: it is not a loop concern at all, just a Thing whose change is a Trigger.

**Q5 — recommendation: no Temporal.** The strongest finding of the survey. Three mature systems achieve durable, restartable, days-long-suspendable conversations with an append-only transcript in a dumb store plus a stateless re-entrant loop. Temporal would buy timers and retries; retries are a few lines around the LLM call (Opencode's are), and timers are a `wakeAt` field plus a periodic scan — which we need the trigger watcher for anyway. Against that stands a cluster to operate and the ADR-0006 violation of a second event history next to the ThingStore. Drop it.

## The concept we should implement

The loop driver is one function, `advance(conversation)`, with no state of its own:

1. Load the Conversation from the ThingStore and build the LLM context from its entries (respecting compaction checkpoints).
2. Run one turn: call the LLM, append its response. Finish reason not `tool-calls` → set `waitingFor: user` (or return the result to the calling Assistant, per ADR-0007) and stop.
3. Execute each tool call. A Tool answers in one of two ways:
   - **immediately** — append the result and continue with the next turn;
   - **pending** — the Operation cannot complete now (Manual Connector, `askUser`, a called Assistant). Append the pending call, set `waitingFor: tool | user | assistant` and optionally `wakeAt`, write the Conversation, stop. The process now holds nothing.
4. A response arriving for a waiting Conversation (Connector delivers, User answers, callee returns, `wakeAt` expires) is appended as an entry and `advance` is called again. Continuation *is* re-entry; there is no second mechanism.

The structural difference between our loop and all three surveyed systems sits in step 3. Coding agents assume every tool returns in seconds, so their loops block on tools inside the turn; our Tools are human-paced by design, so **every tool call is potentially suspending**, and the pending path is the normal path, not the exception. That single generalisation — a tool result may arrive in the same turn or in a later life of the Conversation — is what turns a coding-agent loop into our agentic loop. Everything else — statelessness, store-as-truth, turn granularity, events as projection, compaction in the transcript — we take from the survey as confirmed practice.

---

# What building it settled (2026-08-09)

The loop above was built as written. Four places where reality differed from the survey's
conclusions are worth recording.

**`waitingFor: llm` never appears in the store.** Q2 proposed four values; only three are ever
written. Waiting on the LLM happens *inside* a live Turn, and if the process dies there the
Conversation is simply un-advanced — the next scan finds it and re-runs the Turn, and nothing was
lost that needed a stored state to describe it. The rule the survey derived turns out to be the
whole rule: **only a wait that outlives a Turn is written down.** The stored values are `user`,
`tool` and `assistant`.

**The trigger watcher was indeed the novel component, and the clock was the easy part of it.** Q1
predicted that the piece none of the three surveyed systems has is the piece we would have to design
ourselves, and that was right. What the prediction got wrong is where the difficulty sat. Scanning
for due wake-ups is a range query on an indexed field, and it was written in an afternoon. The hard
part was making **birth exactly once**: a Trigger that fires twice on the same Thing produces a
second Conversation doing the same work, with the same money, in parallel with the first. The answer
is not a timing heuristic and not a watermark — both are *probably* once — but a query, *no
Conversation exists for `(assistantKey, subjectThingId)`*, which stays true across a restart, a
re-scan and a replayed watermark.

**The loop needs a step limit after all.** The survey found no step limit anywhere and concluded we
would not need one. That conclusion holds for what was surveyed and not for what we built: all three
are driven by a human who types a prompt, reads every turn and is present at the moment the work
happens. Ours scans every two seconds, gives birth on its own, and can go a whole day with nobody
looking. So bounds had to exist: `maxTurns` (twenty, reached as a finish reason and an Open Question
rather than a silent stop), a cap on births per hour, an allow-list of the Models a Trigger may fire
on — which is what structurally stops the Runtime triggering on its own Conversations and Assistants,
both of which are Things ([ADR-0003](docs/adr/0003-assistants-are-things.md)) — and a global pause
flag as a kill switch. None of these is a refinement. Without them the first bug is a bill.

**The pending tool call held up exactly as predicted.** Any Tool may answer `pending` instead of
returning a value; the Conversation records the call, what it is now waiting for and optionally when
to give up, and the process holds nothing. Six of the sixteen Operations use it today — asking the
User, calling another Assistant, and the four Manual Connectors — and an Assistant cannot tell which
of its Tools are which, which is the point. That remains the whole structural difference between
this loop and the three that were surveyed.
