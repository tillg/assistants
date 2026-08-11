[TOC]

# Assistants vs OpenClaw

A comparison of this system against **OpenClaw**, Peter Steinberger's locally-running personal
agent, read through **Selma** — the ~11,000-line Python reimplementation
([gkvoelkl/python-selma](https://github.com/gkvoelkl/python-selma)) written as the companion code
to the c't article *"KI-Agenten verstehen: OpenClaw selbst gebaut"*. The article and its figures
are in [`specs/changes/compare_openclaw/`](specs/changes/compare_openclaw/).

This is the sibling of [AGENTIC_LOOP.md](AGENTIC_LOOP.md), which surveyed Opencode, Pi and the
Claude Agent SDK on 2026-08-09 and settled how our loop is built. That matters here, because
**Pi is OpenClaw's first floor**. We have already read it. So the genuinely new material in
OpenClaw is the *second* floor — the gateway, the channels, the heartbeat and the skill market —
and that is where this document spends its time.

Sources are marked. Claims about **Selma** are read from source at commit `37899e0`. Claims about
**OpenClaw itself** come from the article unless stated otherwise, and are marked *(article)*;
they are second-hand and should be treated as such. What could not be verified is listed at the
end.

---

## The two systems, honestly

**OpenClaw** is a personal AI agent you talk to. It runs on your machine, reaches you on
WhatsApp, Telegram, Slack or a web page, remembers you across conversations, wakes on a timer to
check on things, can drive a browser and — if you let it — has full access to your computer.
Capabilities arrive as markdown files; there are said to be over a hundred community skills
*(article)*. It is roughly 350,000 lines *(article)*. Its purpose is **reach and presence**: to be
a competent assistant wherever you are.

**Assistants** does one household's administrative errands. A doctor's invoice arrives, the
Receptionist classifies it, the Accountant proposes a booking and asks *book €96.50 to
Expenses:Health?* — and then stops, for as long as it takes. Its purpose is **unattended,
supervised work on things that cost money**. It is ~6,500 lines of TypeScript over an A12 store,
plus ~10,500 lines of declarative models.

Neither is a worse version of the other. They answer different questions, and almost every
difference below follows from those two sentences.

One number is worth keeping in view: the *concepts* of OpenClaw fit into Selma's ~11,000 lines,
of which the agent core is ~2,100. Our Runtime is ~6,500. The 350,000 is channels, integrations,
packaging and reach — not ideas we are missing.

---

## The layer cake, side by side

The article draws OpenClaw as a three-storey building: the chat model in the basement, the Pi
agent toolkit on the first floor, the gateway on the second, channels above the roof. Tool
execution happens **in the gateway**, not in the loop (article figure 2), because the gateway is
where the security policy lives.

```
OpenClaw / Selma                          Assistants
─────────────────────────────────         ─────────────────────────────────
 Channels                                  UserInterface
 WhatsApp · Telegram · Web · Terminal       one A12 web application
        ▲                                          ▲
        │ normalise, authenticate, route           │ save a form
        ▼                                          ▼
 ┌───────────────────────┐                 ┌───────────────────────┐
 │  GATEWAY              │                 │  THINGSTORE           │
 │  a live process       │  ← control →    │  a store              │
 │  routing, sessions,   │      plane      │  Things, and the      │
 │  policy, tool exec    │                 │  Authority for work   │
 └───────────────────────┘                 └───────────────────────┘
        ▲                                          ▲
        │ owns and calls                           │ polled every 2s
        ▼                                          ▼
 ┌───────────────────────┐                 ┌───────────────────────┐
 │  Pi runtime           │                 │  Runtime              │
 │  Agent + AgentSession │                 │  watcher + advance()  │
 └───────────────────────┘                 └───────────────────────┘
        ▼                                          ▼
    chat model                                 chat model
```

The picture looks similar and the arrows are the point. **OpenClaw's control plane is a process;
ours is a store.** Everything downstream of that follows.

Their gateway is a single process on purpose — the article says so plainly: it "simplifies much
and avoids most of the problems that could arise from running several processes at once". Ours
avoids the same problems by having nothing to run: pending work is a query
([ADR-0011](docs/adr/0011-the-runtime-polls-the-thingstore.md)), and the one process we do have
is capped at a single replica ([ADR-0014](docs/adr/0014-exactly-one-runtime-replica.md)) for a
different reason entirely — A12 has no compare-and-swap.

---

## Vocabulary: what maps onto what

Their words on the left, ours on the right, and the row that matters is the one where the mapping
fails.

| OpenClaw / Selma | Assistants | Same thing? |
|---|---|---|
| Agent | **Assistant** | Roughly. Ours is a *template*; each run is a Conversation. Theirs is one long-lived persona per session key |
| Session | **Conversation** | Yes in role, no in shape. Theirs is a JSONL file per session key; ours is a Thing with an append-only `entries[]` |
| Turn (loop iteration) | **Turn** | Yes. Both mean one model response plus its tool calls |
| Tool | **Tool** / **Operation** | Theirs is a Python callable returning a string. Ours may also answer **pending** — see below |
| Skill (`SKILL.md`) | **Skill** | Both markdown instructions. Theirs are shared and installable; ours belong to exactly one Assistant ([ADR-0009](docs/adr/0009-skills-belong-to-one-assistant.md)) |
| Gateway | *(no equivalent)* | The ThingStore plays the role, but it is a store, not a process |
| Channel | *(no equivalent)* | We have one channel and no abstraction. See "a channel is a Connector" below |
| Heartbeat | **Schedule** Trigger *(inert)* | **False friend.** Ours means something else entirely — see below |
| Memory (`MEMORY.md`, FTS index) | **Process** + the ThingStore | Different by design: they retrieve remembered text, we query authoritative Things |
| Compaction | *(not implemented)* | Same concept, we have not needed it yet |
| `tools_allow` list | **declared Tools** ([ADR-0010](docs/adr/0010-assistants-declare-their-tools.md)) | Same intent, very different enforcement |
| Trace / span (OTel) | **Entry** on the Conversation | Their trace is a developer's projection; our transcript is the record itself |
| — | **Open Question** | No equivalent. Their questions are chat messages |
| — | **Authority** | No equivalent. They cache foreign facts freely |
| — | **intent log**, idempotency key | No equivalent anywhere in either system |

Two rows deserve their own sections because the words collide.

### "Heartbeat" means opposite things

In OpenClaw a heartbeat is **proactivity**: a daemon wakes the agent every *n* minutes so it can
act without being spoken to. The article calls it "the decisive feature". Selma implements it as
a plain `while True: … await asyncio.sleep(interval)` loop that prompts the agent with a fixed
string — *"Read HEARTBEAT.md if it exists. Follow it strictly. … If nothing needs attention,
reply HEARTBEAT_OK."* — and suppresses the reply if the token comes back with under 300 characters
of remainder.

In Assistants a heartbeat is **liveness**: `RuntimeState.heartbeatAt` is stamped at the end of
every *successful* scan, a scan that throws deliberately leaves it untouched, and the compose
healthcheck fails once it is stale
([ADR-0015](docs/adr/0015-nothing-ends-silently.md)). It wakes nothing. It exists because the
escalation path shares fate with the failures it reports, so silence has to be *recorded* silence.

Our word for their thing is a **Schedule** Trigger — and it is inert. `TriggerKind` admits
`schedule`, `Assistant_DM` carries a `cron` field, and no watcher scan fires one. That gap is the
subject of the sharpest learning below.

### "Skill" is the same word for the opposite policy

Both mean markdown instructions for the model. But OpenClaw's skills are a **market** — installed
at runtime, over a hundred of them from the community *(article)* — while
[ADR-0009](docs/adr/0009-skills-belong-to-one-assistant.md) forbids sharing a Skill between two
Assistants on the grounds that "a shared Skill is a shared dependency with no owner".

These are not reconcilable, and neither is wrong. Theirs is right for a personal agent whose
value is breadth. Ours is right for a system where an Assistant's behaviour must be explainable
from its own definition alone, because a wrong explanation costs €184.30.

---

## Where the designs actually differ

Six differences, in descending order of how much structure hangs off them.

### 1. A tool can answer "not yet"

This is the whole game, and it is the one thing neither OpenClaw nor Selma nor any of the three
systems surveyed in [AGENTIC_LOOP.md](AGENTIC_LOOP.md) can express.

In Selma, `AgentTool.execute` returns a `str`. Every failure is `return f"Error: {e}"`. There is
no third answer. A tool that needs a human cannot exist: the loop would have to block, and the
loop is in memory.

In Assistants, `ToolOutcome` has three arms, and the third is the normal path:

```ts
| { kind: "value";   value: unknown }
| { kind: "error";   message: string }
| { kind: "pending"; waitingFor: "user" | "tool" | "assistant"; wakeAt?: string; questionId?: string }
```

Six of our seventeen Operations answer `pending` today — `ui.askUser`, `assistant.call`, and the
four Manual Connectors — and **the Assistant cannot tell which of its Tools are which**, which is
the point. `bank.sendMoney` is fulfilled by a human doing it by hand and reporting back; the day
it becomes a real API, nothing above the Connector changes.

The consequence for the comparison: OpenClaw *appears* to suspend, because when a turn ends the
process holds nothing and a later message re-enters the loop over the stored transcript. But that
is suspension **by accident of the loop ending**, not a modelled state. Nothing records that a
question is outstanding. There is no query for "everything waiting on me". Their inbox is the
chat log; ours is `undefined_match(answeredAt)` over one Model, which is
[ADR-0004](docs/adr/0004-assistants-suspend-and-resume.md)'s demand satisfied literally.

And they cannot suspend *inside* a tool call at all. That is not a gap in their implementation.
It is a gap in what their loop can mean.

### 2. Nobody else has an intent log

[ADR-0012](docs/adr/0012-a-conversation-is-an-intent-log.md) writes the tool call and its
idempotency key **before** the Operation runs, so recovery after a crash asks the Connector
whether the key landed rather than repeating the work. The contract that makes it work is hard:
*every Operation is either read-only or idempotent under a caller-supplied key, and no Operation
may be both mutating and unkeyed.*

Selma has no idempotency of any kind. Neither does Pi, Opencode or the Claude Agent SDK. For a
coding agent that is defensible — re-running `read` is free. For an agent with a `bank.sendMoney`
skill and full system access *(article)*, it is the difference between a bug and a payment made
twice, and the article's architecture has nowhere to put the answer.

This is the single largest thing we have that they do not, and it is not an implementation detail
— it is a contract on every Operation that gets added.

### 3. Their gating is a name list; ours is invisibility, enforced elsewhere

Selma's `tools_allow` is a list of names in `selma.json`, filtered in two independent places: the
prompt's tool list, and the executable set. They can disagree — a misspelled entry is dropped
from execution but **still advertised to the model**, which then calls a tool that does not exist.
The system prompt separately instructs the model to use an `exec` tool with polling semantics; no
such tool is registered. And `browser action=evaluate` is arbitrary JavaScript in a real Chromium,
with `file://` URLs accepted and no domain allowlist.

Ours: `ToolRegistry.grantedTo(assistant)` reads the Assistant's declared `tools[]`, and
`schemasFor()` derives the schemas from that same call — one source, so the two cannot drift. An
undeclared Operation is not refused, it is **invisible**. `bookkeeping.createAccount` exists and is
granted to nobody, which is exactly the granularity
[ADR-0010](docs/adr/0010-assistants-declare-their-tools.md) argued for.

The part that matters most is where the second layer lives. The `runtime` Keycloak role has no
`DOCUMENT_DELETE`, no `MODEL_MANAGE` and no `ASSISTANT_WRITE` — so an Assistant cannot grant
itself a Tool, and the refusal is enforced **by the store, not inside the same LLM-driven process
that would be doing the escalating**. Selma's checks are all in-process, and the process is the
one being defended against.

Selma's gateway, for the record, has no authentication at all: both HTTP endpoints take no
credential, `user_id` is a client-supplied field that flows into the session key, and the Telegram
handler is registered for every message from every user in every group the bot is in. A comment in
`command_manager.py` says commands are "called after the allowlist check" — that check does not
exist. This is a toy reimplementation and should not be read as OpenClaw's posture; but it is a
fair illustration of what a gateway-shaped control plane has to get right and a store-shaped one
never has to think about.

### 4. Memory is retrieval; ours is Authority

Selma remembers in markdown files — `MEMORY.md` curated, `memory/YYYY-MM-DD.md` daily — indexed
into SQLite FTS5 with optional Ollama embeddings, hybrid-scored `0.5·cosine + 0.5·bm25` with an
exponential temporal decay. `AGENTS.md` puts the contract to the model in one line: *"Mental notes
don't survive a restart. Files do."*

It is a good design for its purpose and it is the wrong shape for ours, because retrieval returns
*what was written down*, and we need *what is true*. [ADR-0006](docs/adr/0006-one-authority-per-fact.md)
forbids caching a foreign fact: an Invoice has no `paid` field and no `bookkeepingRef`, because
the User may re-split a transaction in Firefly at any moment, at which point our copy is a lie.
"Is this paid?" is a search against the Authority, every time.

Selma demonstrates the failure mode without meaning to: its `blogwatcher` skill keeps a
`state.json` of content fingerprints — a cached foreign fact with no owner, which is exactly the
thing ADR-0006 exists to prevent.

Our equivalent of durable memory is named and already decided: **Conversations are episodes, the
Process is the plot** ([AGENTIC_LOOP.md](AGENTIC_LOOP.md), Q4). It is passive, any Assistant may
append, and a change to it is itself a Trigger.

Where they are genuinely ahead: between two Conversations, an Assistant of ours carries **nothing**
except what it can look up. That is correct for invoices and thin for anything that needs to learn
the household's habits.

### 5. Their proactivity works; ours is a field name

Selma's heartbeat, whatever its flaws, runs. Ours does not exist. And reading theirs shows what
ours will have to answer, because the mechanism we would reach for first does not fit.

Our exactly-once guarantee for birth is a *query*: no Conversation exists for
`(assistantKey, subjectThingId)`. It is deliberately not a timing heuristic, because a heuristic
is only *probably* once and a second Conversation means a second LLM bill and a second Open
Question for one invoice. **That query has no answer for a Schedule Trigger.** There is no subject
Thing. A clock-fired birth needs a different identity — the natural one is
`(assistantKey, scheduledFor)` where `scheduledFor` is the *due instant*, not the moment the scan
noticed it, so a re-scan, a restart or a replayed watermark all resolve to the same key.

That is a genuine, unrecorded design gap, and it is the most useful thing this comparison found
on our own side.

Two further things Selma has thought about that we would need:

- **A cheap way to say nothing.** Their `HEARTBEAT_OK` token plus a 300-character ack threshold
  exists so a timer that fires 48 times a day does not produce 48 notifications. Ours would
  produce 48 Conversations. That is not a notification problem, it is a cost and a clutter
  problem, and the answer is probably that a scheduled Conversation that finds nothing should end
  `done` with no Open Question and no Process step — quiet by construction, which
  [ADR-0015](docs/adr/0015-nothing-ends-silently.md) already permits because nothing *failed*.
- **Active hours.** A window in which the timer may fire at all. Trivial, and the first thing
  anyone wants.

Note also what Selma's heartbeat is *not*: it is not a scheduler with per-task cadence. It is one
interval, one prompt, one file. Their per-skill scheduling is prompt-level convention — the
`blogwatcher` skill declares itself heartbeat-participating in prose, and nothing in
`heartbeat.py` ever invokes it. Our `cron` field on a Trigger is already a stronger model than the
thing we are learning from.

### 6. Inspectability: they export spans, we *are* the record

The change brief states the position: *"We don't want OpenTelemetry, we need to make our system
inspectable and understandable by itself."* It is worth arguing rather than asserting, because
Selma's tracing is genuinely good and our own docs concede the weak spot.

**Their setup.** OpenTelemetry spans, OpenInference's LLM-specific conventions (`@trace_agent`,
`@trace_chain`, `@trace_tool`), auto-instrumentation of the OpenAI client so every model call is
captured with prompt, response and token counts, exported to Arize Phoenix — local, SQLite-backed,
one command, a browser UI at `:6006`. No cloud. It is opt-in: with no exporter registered the
tracer is a no-op and nothing breaks.

**The strongest case for it.** We have no token accounting at all — neither provider reads
`usage`, despite [CONTEXT.md](CONTEXT.md) calling the Turn "the unit in which cost is counted".
Our correlation between log lines is a manual convention. And our own documents admit, in four
places, that `just logs runtime` is a better debugging surface than the transcript, because *"a
Conversation's transcript renders as a data grid, not a transcript view"*. Phoenix would fix the
developer experience tomorrow.

**Why the position still holds.** Three reasons, in order of weight.

1. **A span tree is a developer's view of one process. Our audit surface must be the User's view
   of the household's work.** The User is the supervisor of every Assistant's activity — that is
   in the definition of the word. An observability stack they never open is not supervision.
2. **It would be a second event history beside the ThingStore.** That is exactly the
   [ADR-0006](docs/adr/0006-one-authority-per-fact.md) objection that killed Temporal in
   [AGENTIC_LOOP.md](AGENTIC_LOOP.md) Q5, and it does not get weaker because the second store is
   read-only. Our transcript is not a projection of the run — it *is* the run, and the loop reads
   it back on every Turn.
3. **We already have the durable correlation key, and it is better than a trace id.** The
   idempotency key `<conversationId>:<seq>` identifies a tool call, is written into the transcript
   before the call happens, survives a restart, and is the thing recovery searches the Authority
   for. A trace id does none of that.

**But the concession is real, and it points somewhere useful.** The envy here is not for spans.
It is for a *reader*. What Phoenix gives Selma is a screen where a run is legible; what we have is
a data grid and a log tail. So the honest conclusion is:

> The OpenTelemetry question is really two questions, and only one of them is interesting. Do we
> want to export telemetry to a second store? No. Do we want a transcript view of a Conversation?
> Yes, badly — and that is a UserInterface change, not an instrumentation one.

The reason we do not have it is recorded and is a good reason: a transcript viewer is custom
client code, which [D-005](DECISIONS.md) exists to avoid. That trade should be revisited on its
own merits, not smuggled in as observability.

There is one thing worth taking from OpenInference regardless, and it is small: **record the
token usage on the Turn.** Both real providers already receive `usage` in the response and drop
it. Two fields on an Entry, no new dependency, no second store, and it makes CONTEXT.md's sentence
about the Turn true.

---

## A channel is a Connector, not a control plane

This is the reframing that makes OpenClaw's most visible feature buildable here without touching
the architecture, and it is worth stating on its own.

OpenClaw's gateway must own channels, because the loop is live: something has to hold the socket,
normalise the message, find the session and route the reply. That is a control plane, and it is
why the gateway exists.

We need none of that, because a question is already a **Thing**. `ui.askUser` writes an Open
Question and the Conversation stops. Anything at all can render that question and write the answer
back; the Runtime notices on its next scan and cannot tell what rendered it. The A12 web
application is simply the renderer we have.

So "add Telegram" in our shape is:

- a **Connector** for the UserInterface, which posts an unanswered Open Question to a chat and
  writes the reply into the Thing's answer field;
- no gateway, no channel registry, no session routing, no normalised message envelope, no
  second authority for pending work;
- and — the part that makes it worth doing — it composes with **Manual Connectors** for free.
  *"Send this email and tell me when you have"* is already an Open Question of kind `perform`. On
  Telegram it is a message you can answer from a train.

One thing such a Connector would have to get right, and it is not obvious:
[ADR-0014](docs/adr/0014-exactly-one-runtime-replica.md) gives the Open Question **one writer after
creation, the User**. A connector living inside the Runtime that stamped the answer onto that
document would be a second Runtime write to a document the User may be editing — the exact hazard
that moved answer *consumption* onto the Conversation in the first place. So the answer has to
arrive either as the User (the connector authenticating as them) or as an Entry on the
Conversation the Runtime already owns. Which of the two is a real decision, and it is the only
part of "add a channel" that is not already solved.

The same argument explains why we should not adopt their gateway even if we wanted five channels.
Their normalised envelope (`body` / `body_for_agent` / `body_for_commands`) and their per-channel
delivery callbacks exist to solve routing problems that only exist because the loop is live.
Ours are already solved by the store.

Two things from their channel layer *are* worth remembering when we build one: a channel must
carry the **sender identity into the prompt as untrusted text** (Selma concatenates a Telegram
display name straight into the agent's input — an injection vector by itself), and outbound
delivery must be **awaited and error-checked**, which Selma's fire-and-forget `create_task` sends
are not.

---

## What we should learn

Ranked, with a verdict, what it costs and what it would need.

| # | Learning | Verdict | Cost | Needs |
|---|---|---|---|---|
| 1 | A Schedule Trigger needs its own exactly-once identity — `(assistantKey, scheduledFor)`, keyed on the *due instant* | **Adopt** | Small, once designed | An ADR; the watcher's seventh scan |
| 2 | A channel is a Connector for the UserInterface, not a gateway | **Adopt** (as the design) | Nothing to decide; a Connector to build | Nothing new — it is already the shape |
| 3 | Record token usage on the Turn | **Adopt** | Two fields, both providers already receive it | A model change |
| 4 | A scheduled Conversation that finds nothing must be quiet by construction | **Adopt** | Free — a convention in the Assistant's prompt | Nothing |
| 5 | Active hours on a Schedule | **Adopt** with (1) | Trivial | Same ADR |
| 6 | Compaction as a **Turn-boundary step recorded as an Entry** — never a background task | **Adapt, later** | Medium | The `maxTurns`-reached path already exists to hang it on |
| 7 | Progressive disclosure of Skills — inject an index, let the model fetch the body | **Adapt, later** | Medium; needs a `skill.read` Operation | Only worth it past ~10 Skills on one Assistant. The most any of ours has is 3 |
| 8 | Order the system prompt stable-first, volatile-last, with an explicit boundary | **Adopt** | Nearly free | A comment and a reordering in `buildMessages` |
| 9 | A capability-fallback ladder — step down when the provider refuses a feature, rather than failing | **Adapt** | Small | Fits the existing transient-retry tier |
| 10 | A transcript **view** in the UserInterface | **Revisit** | This is the D-005 trade, taken deliberately | Its own change |
| 11 | Markdown skills discovered from a folder | **Reject** | — | Skills are fields on an Assistant Thing (ADR-0009). A folder is a second authoring path |
| 12 | A shared/community skill library | **Reject** | — | ADR-0009 forbids it, for a reason that gets stronger when money is involved |
| 13 | A gateway process as the control plane | **Reject** | — | ADR-0011. It would be a second place to ask "is there work?" |
| 14 | OpenTelemetry export | **Reject** | — | ADR-0006. See above; the real need is (10) |
| 15 | Full system access / an `exec` tool | **Reject** | — | ADR-0010's granularity is the whole point |

Three cautionary findings — things Selma does that we should make sure we never start doing:

- **Never classify an error by matching prose.** Selma decides a context overflow happened by
  substring-matching the model's own reply text for "context window". Asking it what its context
  window is therefore triggers a false overflow, a memory flush, three retries and an error
  message instead of the answer. Our failure policy tiers on transport status and finish reason,
  which is why this cannot happen here — worth keeping that way.
- **Never let a background task mutate the running context.** Selma's proactive compaction is a
  fire-and-forget `asyncio.create_task` fired from inside context-building; it races the loop,
  can rewrite the message list mid-turn, and its exceptions are unobserved. If we ever add
  compaction, it is a step *in* a Turn and an Entry *in* the transcript.
- **One source for what a model may call.** Selma derives the advertised tool list and the
  executable tool list separately, and they drift. Ours derive both from `grantedTo`, with a belt
  check at execution and a test for it. Keep the belt.

---

## Where our concepts are stronger

For *this* system's purpose — unattended household admin under supervision. Several of these would
be over-engineering in a personal chat agent.

1. **Waiting is free, and it is a modelled state.** An Assistant that has asked a question holds
   nothing; the question *is* its state. Three weeks and any number of restarts cost nothing, and
   "everything waiting on the User" is one indexed query. OpenClaw gets the *statelessness* by
   accident of the loop ending; it does not get the queryable pending state, and it cannot suspend
   inside a tool call at all.
2. **Every tool call is potentially suspending.** A human-paced Operation is expressible. That one
   generalisation is what turns a coding-agent loop into ours, and nothing in either system can
   express it.
3. **The intent log and keyed idempotency.** Nobody else has this, and it is the difference
   between a crash and booking €96.50 twice.
4. **One Authority per fact.** No cached foreign facts, therefore no lies to reconcile. Selma's
   memory design is a retrieval index over things it wrote down; ours is a query against whoever
   owns the truth.
5. **Tool permission that the agent's own process cannot grant itself.** Declaration filters the
   schemas so undeclared Operations are invisible, and the store withholds `ASSISTANT_WRITE` from
   the Runtime entirely.
6. **Exactly-once birth as a query, not a heuristic.** Survives restart, re-scan and a replayed
   watermark.
7. **Nothing ends silently**, with the meta-rule that the escalation path shares fate with the
   failures it reports — hence a liveness heartbeat and a healthcheck that reads it. There is one
   place for the User to look, and it is the same place as everything else.
8. **Bounds on an LLM loop with a credit card**: `maxTurns`, a births-per-hour cap, a
   trigger-eligible allow-list that structurally prevents feeding on our own output, `enabled`,
   and a global pause. Selma's loop has *no* turn cap and *no* token budget: a model that keeps
   calling tools loops until something else breaks. That is survivable when a human is watching
   every reply, and it is not survivable unattended.
9. **The Assistant is a governed Thing, not a folder.** Prompts, Skills, Triggers and Tools are
   fields on a modelled document with a form, edited in the same UI as everything else
   ([ADR-0003](docs/adr/0003-assistants-are-things.md)). Selma's equivalent is seven markdown files
   in a workspace directory plus a JSON config — and its installer writes `MEMORY.md` to a path
   the loader does not read, so the curated long-term memory never reaches the prompt. A modelled
   field cannot be in the wrong place.
10. **The vocabulary is enforced.** [CONTEXT.md](CONTEXT.md) lists forbidden synonyms per term.
    That is not stylistic — it is why "waiting" means one thing in the models, the code and the
    prose.

---

## Where they are stronger

Stated plainly, because a comparison that only flatters is useless.

1. **Reach.** They meet the User on the messenger the User already has open. We require opening a
   web application on localhost. For a system whose entire value is a question getting answered,
   that is not a small thing — it is the difference between a two-second answer and a three-day
   one.
2. **Proactivity exists.** However crude, their timer runs. Our Schedule Trigger is a field name.
3. **Memory across runs.** An Assistant of ours starts each Conversation knowing nothing it cannot
   look up. Theirs accumulates a picture of its user.
4. **Compaction.** A months-long Conversation will need it, we know it, and we do not have it.
5. **Streaming.** Both our providers are single non-streaming calls. Nothing watches a live run,
   so nothing has demanded it — but it is why the system feels like a batch job.
6. **Cost of entry.** Ollama plus a Python process, no key, no cloud. Ours is nine containers, a
   Keycloak realm and a modelling toolchain. That buys model rigour ([ADR-0001](docs/adr/0001-a12-as-the-platform.md))
   and it is not free.
7. **Extension without ceremony.** Drop a `SKILL.md` in a folder and the agent can use it. Adding
   an Operation here is TypeScript, and adding a Model is a nine-step checklist.
8. **An ecosystem.** Over a hundred community skills *(article)*. We have five, all ours.

And two things they do that are stronger in *their* context and that we should still not copy:
full system access (their reach depends on it; ours would be an unbounded Tool grant), and
runtime-installable skills (their breadth depends on it; ours would be a second authoring path
around ADR-0009 and ADR-0003).

---

## The thing to take away

OpenClaw and Assistants both concluded that the store is the truth and the loop holds nothing.
That convergence is real and, as [AGENTIC_LOOP.md](AGENTIC_LOOP.md) already found across three
other systems, it appears to be the shape of the problem rather than anyone's taste.

They then diverged on one question: **who owns "what is pending?"** OpenClaw answers *the
gateway* — a live process that routes, authenticates and executes. We answer *the store* — pending
work is a query, and nothing is entitled to answer it but the Authority. Their answer buys reach:
five channels, a heartbeat, a hundred skills, a presence. Ours buys the ability to stop for three
weeks in the middle of a payment and be exactly where it was.

The most valuable thing this comparison produced is not a feature to copy. It is that our own
Schedule Trigger — the one piece we would build to close the most visible gap — cannot use the
exactly-once mechanism the rest of the system relies on, and nobody had noticed.

---

## What could not be verified

- **Everything about OpenClaw itself is second-hand.** The gateway's internals, the ~350,000
  lines, the hundred-plus community skills, the full-system-access guardrails and the browser
  control are the article's claims, marked *(article)* throughout. OpenClaw's own source was not
  read for this document. Where a claim about "OpenClaw" is load-bearing above, it is load-bearing
  on Selma's reimplementation of it, which is explicitly a toy.
- **The article is paywalled** (heise+). The copy in `specs/changes/compare_openclaw/` is what was
  read.
- **Pi was read once already, not again here.** Its `Agent`/`AgentSession` split, `steer()`,
  `followUp()`, JSONL branching and compaction are as recorded in
  [AGENTIC_LOOP.md](AGENTIC_LOOP.md) on 2026-08-09, from source. Selma's `my_mono` is a
  reimplementation of Pi, not Pi.
- **Selma's claims are source-read, not run.** Nothing was executed. The bugs cited — the drifting
  tool lists, the prose-matched error classification, the racing compaction task, the missing
  auth — are static findings.
- **Selma is not the current line.** Its own `pyproject.toml` already points at a successor,
  `gkvoelkl/python-selmakit` ("Rebuilding OpenClaw with Pydantic-AI 2"), which reportedly adds
  scheduling decorators, MCP support with approval gating, and sub-agent delegation. If any of the
  learnings above are pursued, that is the repository to read first — not this one.
