[TOC]

# Assistants vs OpenClaw

A comparison of this system against **OpenClaw** ([openclaw/openclaw](https://github.com/openclaw/openclaw),
MIT, ~90% TypeScript), Peter Steinberger's locally-running personal agent. It was read three ways:
the c't article *"KI-Agenten verstehen: OpenClaw selbst gebaut"* and its figures, which are in
[`specs/changes/compare_openclaw/`](compare_openclaw/); **Selma**
([gkvoelkl/python-selma](https://github.com/gkvoelkl/python-selma)), the ~11,000-line Python
reimplementation written as the article's companion code, read at source; and OpenClaw's own
repository, package history and security documentation.

This is the sibling of [AGENTIC_LOOP.md](AGENTIC_LOOP.md), which surveyed Opencode, Pi and the
Claude Agent SDK on 2026-08-09 and settled how our loop is built.

**Read the article with a date in mind.** It describes OpenClaw as a building whose first floor is
Mario Zechner's **Pi** toolkit. That was true from launch until **2026-05-28**, when OpenClaw
dropped three of the four Pi packages — `pi-ai`, `pi-agent-core` and `pi-coding-agent` — and kept
only `pi-tui`, the terminal-UI renderer. Since then it runs its own agent runtime. The article's
ground and first floors are therefore ten weeks stale; its **second** floor — the gateway, the
channels, the heartbeat, the skills — is the part that still describes the system, and it is where
this document spends its time. (Pi itself is not stale to us: it is one of the three systems
AGENTIC_LOOP.md read from source, and it lives at
[earendil-works/pi](https://github.com/earendil-works/pi).)

Claims are marked **(article)** where they rest only on the c't piece, **(Selma)** where they come
from Selma's source, and are otherwise from OpenClaw's own repository and docs. What could not be
verified is listed at the end.

---

## The two systems, honestly

**OpenClaw** is a personal AI agent you talk to. It runs on your machine, reaches you on some
twenty-six channel integrations, remembers you across conversations, wakes on a schedule to check
on things, drives a browser, and — if you let it — has full access to your computer. Capabilities
arrive as markdown skills, installable at runtime from a public hub. It is **~3.9M non-test lines
across all languages** (~1.75M if you count only non-test TypeScript under `src/`), with more test
code than production code, ~78,000 commits since November 2025 and ~3,000 contributors. Its purpose
is **reach and presence**: to be a competent assistant wherever you are.

**Assistants** does one household's administrative errands. A doctor's invoice arrives, the
Receptionist classifies it, the Accountant proposes a booking and asks *book €96.50 to
Expenses:Health?* — and then stops, for as long as it takes. Its purpose is **unattended,
supervised work on things that cost money**. It is ~6,500 lines of TypeScript over an A12 store,
plus ~10,500 lines of declarative models.

Neither is a worse version of the other. They answer different questions, and almost every
difference below follows from those two sentences.

One correction worth making explicitly, because it changes how the comparison should feel: the
article's **"circa 350,000 lines"** is not supportable. No primary source for it exists, and a
measurement of the tree at HEAD puts the real figure an order of magnitude higher, by two
independent methods that agree to 0.3%. This is not a project one household could read. Selma's
~11,000 lines are the *concepts*; our ~6,500 are a different set of concepts; OpenClaw's millions
are twenty-six channels, three mobile apps, a plugin system, a hub and a security programme.

---

## The layer cake, side by side

The article draws OpenClaw as a three-storey building: the chat model on the ground floor, the Pi
agent toolkit on the first, the gateway on the second, channels above the roof. Tool execution
happens **in the gateway**, not in the loop (article figure 2), because the gateway is where the
policy lives. The first floor is now in-house rather than Pi's, and the shape is unchanged.

```
OpenClaw                                  Assistants
─────────────────────────────────         ─────────────────────────────────
 Channels  (26 integrations)               UserInterface
 Discord · Telegram · WhatsApp · …          one A12 web application
        ▲                                          ▲
        │ normalise, authenticate, route           │ save a form
        ▼                                          ▼
 ┌───────────────────────┐                 ┌───────────────────────┐
 │  GATEWAY              │                 │  THINGSTORE           │
 │  a live process       │  ← control →    │  a store              │
 │  channels, sessions,  │      plane      │  Things, and the      │
 │  auth, tool policy    │                 │  Authority for work   │
 └───────────────────────┘                 └───────────────────────┘
        ▲                                          ▲
        │ owns and calls                           │ polled every 2s
        ▼                                          ▼
 ┌───────────────────────┐                 ┌───────────────────────┐
 │  agent runtime        │                 │  Runtime              │
 │  turn loop, context,  │                 │  watcher + advance()  │
 │  compaction, skills   │                 │                       │
 └───────────────────────┘                 └───────────────────────┘
        ▼                                          ▼
    chat model                                 chat model
```

The picture looks similar and the arrows are the point. **OpenClaw's control plane is a process;
ours is a store.** Everything downstream of that follows.

The division of labour is clean on their side and worth stating, because it is what dropping Pi
did *not* change: the **gateway** owns everything *around* a run — the exclusive channel
connections, routing and session ownership, authentication, device pairing, operator scopes, tool
policy and exec approvals, all over one multiplexed WebSocket+HTTP control plane on
`127.0.0.1:18789`. The **agent runtime** owns everything *inside* a run — the turn loop, streaming,
tool invocation, context assembly, compaction, skill injection. Pi was only ever the second column.

We have no first column at all, and that is the design: pending work is a query
([ADR-0011](../../docs/adr/0011-the-runtime-polls-the-thingstore.md)), so there is nothing to route,
nothing to hold a session, and no second place to ask what is outstanding.

### One process, asserted versus enforced

Both systems insist on a single instance, and the comparison is not flattering to us.

They enforce it in three ordered layers: a state-ownership lock keyed on the canonical state
directory (which *every* gateway takes, including ones started with the multi-gateway escape
hatch, so destructive maintenance cannot race a live owner), a config lock, and an exclusive TCP
bind. Stale owners are detected by reading the holder's command line; a bind conflict retries
twenty times and then exits with a code chosen so systemd will stop restarting it.

We *assert* it. [ADR-0014](../../docs/adr/0014-exactly-one-runtime-replica.md) says compose runs exactly
one replica and is explicit that `leaseUntil` is crash recovery rather than mutual exclusion,
because A12 has no compare-and-swap. That reasoning is right, and the conclusion drawn from it is
that the constraint lives in the deployment. Nothing checks. A second Runtime started by hand
against the same store would find expired leases and take them, and the first symptom would be two
Conversations doing one invoice.

[ADR-0017](../../docs/adr/0017-the-runtime-claims-ownership-and-stands-down.md) closes that, and is
careful about what it can honestly claim: without compare-and-swap you cannot build mutual
exclusion on the store, so what it buys is a second Runtime that refuses to start and says why,
and a first Runtime that stands down when it finds it has been superseded. ADR-0014's constraint is
unchanged — this is fast, visible failure rather than a lock.

---

## Vocabulary: what maps onto what

Their words on the left, ours on the right, and the rows that matter are the ones where the
mapping fails.

| OpenClaw | Assistants | Same thing? |
|---|---|---|
| Agent | **Assistant** | Roughly. Ours is a *template*; each run is a Conversation. Theirs is one long-lived persona per session |
| Session | **Conversation** | Yes in role, no in shape. Theirs is a JSONL file; ours is a Thing with an append-only `entries[]` |
| Turn | **Turn** | Yes. Both mean one model response plus its tool calls |
| Tool | **Tool** / **Operation** | Theirs returns a value or throws. Ours may also answer **pending** — see below |
| Skill (`SKILL.md`) | **Skill** | Both markdown, both progressively disclosed. Theirs are shared and installable; ours belong to exactly one Assistant ([ADR-0009](../../docs/adr/0009-skills-belong-to-one-assistant.md)) |
| Gateway | *(no equivalent)* | The ThingStore plays the role, but it is a store, not a process |
| Channel | *(no equivalent)* | We have one and no abstraction. See "a channel is a Connector" below |
| Heartbeat | **Schedule** Trigger *(inert)* | **False friend.** Ours means something else entirely — see below |
| Automation / cron | **Schedule** Trigger *(inert)* | Theirs is the real scheduler; the heartbeat is one of its jobs |
| Memory (`MEMORY.md`, SQLite index) | **Process** + the ThingStore | Different by design: they retrieve remembered text, we query authoritative Things |
| `origin_class` on a memory chunk | *(no equivalent)* | **The gap this comparison found.** See §7 |
| Compaction | *(not implemented)* | Same concept, we have not needed it yet |
| Tool policy / exec approvals | **declared Tools** ([ADR-0010](../../docs/adr/0010-assistants-declare-their-tools.md)) | Same intent; ours is declaration, theirs is runtime policy |
| — | **Open Question** | No equivalent. Their questions are chat messages |
| — | **Authority** | No equivalent. They cache foreign facts freely |
| — | **intent log**, idempotency key | No equivalent in either system |

Two rows deserve their own sections because the words collide.

### "Heartbeat" means opposite things

In OpenClaw a heartbeat is **proactivity**: the agent is woken on a cadence so it can act without
being spoken to. The article calls it the decisive feature, and it is better engineered than the
article suggests — it is not a bare timer but a **system-managed job of the Automations
scheduler**, which means it inherits quiet hours, a cadence cap, deferral while the main queue is
busy, retry backoff, and auto-disable after ten consecutive failures. Turn `cron` off and the
heartbeat stops with it; there is no fallback timer. Several skip paths short-circuit *before* the
model is called at all — an empty instruction file, no route, alerts disabled — so a heartbeat
that has nothing to do usually costs nothing.

In Assistants a heartbeat is **liveness**: `RuntimeState.heartbeatAt` is stamped at the end of
every *successful* scan, a scan that throws deliberately leaves it untouched, and the compose
healthcheck fails once it is stale ([ADR-0015](../../docs/adr/0015-nothing-ends-silently.md)). It wakes
nothing. It exists because the escalation path shares fate with the failures it reports, so
silence has to be *recorded* silence.

Our word for their thing is a **Schedule** Trigger — and it is inert. `TriggerKind` admits
`schedule`, `Assistant_DM` carries a `cron` field, and no watcher scan fires one. That gap is the
subject of §6.

### "Skill" is the same word for the opposite policy

Both mean markdown with YAML frontmatter, and — this surprised me — both are **progressively
disclosed**: OpenClaw puts only name and description in the prompt and has the model read the body
with the ordinary `read` tool when it decides the skill applies. We do the opposite and inject every
Skill body into every system prompt on every Turn.

The divergence is ownership. OpenClaw's skills are a **market**: discovered from precedence-ordered
roots up to six levels deep, installable at runtime from a hub or a git ref, gated by declared
binary/env/config/OS requirements. [ADR-0009](../../docs/adr/0009-skills-belong-to-one-assistant.md)
forbids sharing a Skill between two Assistants at all, on the grounds that "a shared Skill is a
shared dependency with no owner".

These are not reconcilable, and neither is wrong. Theirs is right for a personal agent whose value
is breadth. Ours is right for a system where an Assistant's behaviour must be explainable from its
own definition alone, because a wrong explanation costs €184.30.

Their own experience is the argument for our side. A published analysis demonstrated a hub skill
exfiltrating data through an embedded `curl`; the response was a scanner, then a defensive tool.
And OpenClaw's self-learning feature defaults to *applying* captured skills through a scanner-gated
path with no operator review. A market needs a scanner. A field on a Thing needs nobody.

---

## Where the designs actually differ

Seven differences, in descending order of how much structure hangs off them.

### 1. A tool can answer "not yet"

This is the whole game, and it is the one thing neither OpenClaw nor Selma nor any of the three
systems surveyed in [AGENTIC_LOOP.md](AGENTIC_LOOP.md) can express.

A tool in their world returns a value or reports an error; a throwing tool comes back to the model
as `isError`. There is no third answer. A tool that needs a human cannot exist, because the loop
would have to block and the loop is in memory.

In Assistants, `ToolOutcome` has three arms, and the third is the normal path:

```ts
| { kind: "value";   value: unknown }
| { kind: "error";   message: string }
| { kind: "pending"; waitingFor: "user" | "tool" | "assistant"; wakeAt?: string; questionId?: string }
```

Six of our seventeen Operations answer `pending` today — `ui.askUser`, `assistant.call`, and the
four Manual Connectors — and **the Assistant cannot tell which of its Tools are which**, which is
the point. `bank.sendMoney` is fulfilled by a human doing it by hand and reporting back; the day it
becomes a real API, nothing above the Connector changes.

OpenClaw *appears* to suspend, because when a turn ends the process holds nothing and a later
message re-enters the loop over the stored session. But that is suspension **by accident of the
loop ending**, not a modelled state. Nothing records that a question is outstanding; there is no
query for "everything waiting on me". Their inbox is the chat; ours is
`undefined_match(answeredAt)` over one Model, which is
[ADR-0004](../../docs/adr/0004-assistants-suspend-and-resume.md)'s demand satisfied literally.

And they cannot suspend *inside* a tool call at all. That is not a gap in their implementation. It
is a gap in what their loop can mean.

### 2. Nobody else has an intent log

[ADR-0012](../../docs/adr/0012-a-conversation-is-an-intent-log.md) writes the tool call and its
idempotency key **before** the Operation runs, so recovery after a crash asks the Connector whether
the key landed rather than repeating the work. The contract that makes it work is hard: *every
Operation is either read-only or idempotent under a caller-supplied key, and no Operation may be
both mutating and unkeyed.*

Nothing of the shape appears in Selma, and nothing of the shape turned up in Pi, Opencode or the
Claude Agent SDK. For a coding agent that is defensible: re-running `read` is free. For an agent
with shell access and money-moving skills it is the difference between a crash and a payment made
twice, and there is nowhere in that architecture to put the answer.

### 3. Their gating is runtime policy; ours is invisibility, enforced elsewhere

OpenClaw gates seriously — the gateway owns tool policy and exec approvals, device pairing and
operator scopes, behind an Ed25519 challenge-response handshake on a versioned protocol. This is
not a toy, and Selma's reimplementation should not be read as OpenClaw's posture: Selma's gateway
has no authentication whatsoever, its `user_id` is a client-supplied field that flows into the
session key, and a comment claiming commands run "after the allowlist check" describes a check that
does not exist. **(Selma)**

The interesting difference is not strength, it is *kind*. Theirs is a policy consulted at call
time; ours is a declaration that changes what exists. `ToolRegistry.grantedTo(assistant)` reads the
Assistant's declared `tools[]`, and `schemasFor()` derives the offered schemas from that same call —
one source, so the advertised set and the executable set cannot drift. An undeclared Operation is
not refused, it is **invisible**. `bookkeeping.createAccount` exists and is granted to nobody, which
is exactly the granularity [ADR-0010](../../docs/adr/0010-assistants-declare-their-tools.md) argued for.

And the second layer sits outside the process being defended: the `runtime` Keycloak role holds no
`DOCUMENT_DELETE`, no `MODEL_MANAGE` and no `ASSISTANT_WRITE`, so an Assistant cannot grant itself a
Tool and the refusal is enforced **by the store, not inside the same LLM-driven process that would
be doing the escalating**.

A runtime policy can be argued with; a schema that was never sent cannot.

### 4. Memory is retrieval; ours is Authority

OpenClaw remembers in markdown — a curated `MEMORY.md`, a `USER.md`, daily notes, imported
transcripts — indexed into SQLite with BM25 plus embeddings. A nightly "dreaming" job is the only
durable writer of the curated file. Selma's smaller version of the same design hybrid-scores
`0.5·cosine + 0.5·bm25` with exponential temporal decay. **(Selma)**

It is a good design for its purpose and the wrong shape for ours, because retrieval returns *what
was written down* and we need *what is true*.
[ADR-0006](../../docs/adr/0006-one-authority-per-fact.md) forbids caching a foreign fact: an Invoice has
no `paid` field and no `bookkeepingRef`, because the User may re-split a transaction in Firefly at
any moment, at which point our copy is a lie. "Is this paid?" is a search against the Authority,
every time.

Selma demonstrates the failure mode without meaning to: its `blogwatcher` skill keeps a
`state.json` of content fingerprints — a cached foreign fact with no owner, exactly what ADR-0006
exists to prevent. **(Selma)**

Our equivalent of durable memory is named and already decided: **Conversations are episodes, the
Process is the plot** ([AGENTIC_LOOP.md](AGENTIC_LOOP.md), Q4). It is passive, any Assistant may
append, and a change to it is itself a Trigger.

Where they are genuinely ahead: between two Conversations, an Assistant of ours carries **nothing**
except what it can look up. That is correct for invoices and thin for anything that needs to learn
the household's habits.

### 5. Inspectability: they export spans, we *are* the record

The change brief states the position: *"We don't want OpenTelemetry, we need to make our system
inspectable and understandable by itself."* It is worth arguing rather than asserting.

**Their setup.** OpenTelemetry spans with OpenInference's LLM conventions (`@trace_agent`,
`@trace_chain`, `@trace_tool`), auto-instrumentation of the model client so every call is captured
with prompt, response and token counts, exported to Arize Phoenix — local, SQLite-backed, one
command, a browser UI. Opt-in: with no exporter registered the tracer is a no-op. **(Selma)**

**The strongest case for it.** We have no token accounting at all — neither provider reads `usage`,
despite [CONTEXT.md](../../CONTEXT.md) calling the Turn "the unit in which cost is counted". Our
correlation between log lines is a manual convention. And five separate documents in this
repository concede the same sentence — *"a Conversation's transcript renders as a data grid, not a
transcript view"* — with `just logs runtime` named as the better debugging surface.

**Why the position still holds.** Three reasons, in order of weight.

1. **A span tree is a developer's view of one process. Our audit surface must be the User's view of
   the household's work.** The User is the supervisor of every Assistant's activity — that is in
   the definition of the word. An observability stack they never open is not supervision.
2. **It would be a second event history beside the ThingStore.** That is exactly the
   [ADR-0006](../../docs/adr/0006-one-authority-per-fact.md) objection that killed Temporal in
   [AGENTIC_LOOP.md](AGENTIC_LOOP.md) Q5, and it does not get weaker because the second store is
   read-only. Our transcript is not a projection of the run — it *is* the run, and the loop reads it
   back on every Turn.
3. **We already have the durable correlation key, and it is better than a trace id.** The
   idempotency key `<conversationId>:<seq>` identifies a tool call, is written into the transcript
   before the call happens, survives a restart, and is what recovery searches the Authority for. A
   trace id does none of that.

**But the concession is real, and it points somewhere useful.** The envy is not for spans. It is
for a *reader*. So:

> The OpenTelemetry question is really two questions, and only one is interesting. Do we want to
> export telemetry to a second store? No. Do we want a transcript view of a Conversation? Yes,
> badly — and that is a UserInterface change, not an instrumentation one.

The reason we do not have one is recorded and is a good reason: a transcript viewer is custom client
code, which [D-005](../../DECISIONS.md) exists to avoid. That trade should be revisited on its own merits,
not smuggled in as observability.

One thing is worth taking regardless, and it is small: **record the token usage on the Turn.** Both
providers already receive `usage` in the response and drop it. Two fields on an Entry, no new
dependency, no second store, and it makes CONTEXT.md's sentence about the Turn true.

### 6. Their proactivity works; ours is a field name

Theirs runs, with quiet hours, a cadence cap, busy-deferral, retry backoff and auto-disable after
ten consecutive failures. Ours does not exist. Reading theirs shows what ours will have to answer,
because the mechanism we would reach for first does not fit.

Our exactly-once guarantee for birth is a *query*: no Conversation exists for
`(assistantKey, subjectThingId)`. It is deliberately not a timing heuristic, because a heuristic is
only *probably* once and a second Conversation means a second LLM bill and a second Open Question
for one invoice. **That query has no answer for a Schedule Trigger.** There is no subject Thing. A
clock-fired birth needs a different identity — the natural one is `(assistantKey, scheduledFor)`
where `scheduledFor` is the *due instant*, not the moment the scan noticed it, so a re-scan, a
restart and a replayed watermark all resolve to the same key.

Half a dozen documents recorded that a Schedule Trigger is inert without any of them recording that
the mechanism for making one safe did not yet exist. That is now settled in
[ADR-0016](../../docs/adr/0016-a-schedule-fires-on-its-due-instant.md), which also takes the three policy
decisions the mechanism forces — catch up once rather than per missed slot, skip while the previous
firing is unfinished, and resolve the cron to a UTC instant before it becomes an identity, so
daylight saving cannot make one firing look like two.

Four further things their scheduler has thought about that ours would need:

- **A cheap way to say nothing.** Their skip-before-model-call paths cost nothing at all, and their
  `HEARTBEAT_OK` convention drops a reply whose remainder is under 300 characters. Ours would
  produce a Conversation per firing. The answer is probably that a scheduled Conversation finding
  nothing ends `done` with no Open Question and no Process step — quiet by construction, which
  [ADR-0015](../../docs/adr/0015-nothing-ends-silently.md) already permits because nothing *failed*.
- **Active hours**, with the edge case they hit: equal start and end must mean *never*, not
  *always*.
- **Auto-disable after N consecutive failures.** Our escalation cap is per-Conversation. A Schedule
  firing into a permanently broken Authority would raise three questions per Conversation, for ever,
  one Conversation per firing. `Assistant.enabled` already exists as the off switch; nothing sets it.
- **Deferral while busy**, so a slow Conversation does not overlap its own next firing.

### 7. Untrusted text, and who is allowed to become an instruction

This is the section that changed my view of our own system, and it exists because of published
criticism of theirs.

Palo Alto Networks published a threat model of OpenClaw in January 2026 naming the "lethal
trifecta" — private data, untrusted content and external communication in one agent — and one
distinctive attack: **time-shifted prompt injection**, where persistent memory lets an injected
payload sit for weeks before it triggers.

OpenClaw's answer is structural and genuinely responsive. Memory provenance is owned by SQLite and
is **not writable through prose**: every chunk carries an `origin_class` of `owner`, `agent`,
`untrusted` or `system`, and a `session_kind` of `interactive`, `cron`, `heartbeat`, `subagent` or
`unknown`. Cron, heartbeat and subagent sessions **produce no durable memory candidates at all**,
and `untrusted` and `system` candidates are dropped *before the consolidation prompt is built*.
Only the root `MEMORY.md` and `USER.md` are auto-injectable; everything else is searchable but never
injected — the docs call this "a security property, not a tuning choice."

It is also, by their own account, partial: their threat model rates direct prompt injection
*"Critical — detection only, no blocking"*, and their security policy excludes injection-only
reports from scope unless they cross an auth or sandbox boundary.

**Now ours.** The phrase "prompt injection" appears **nowhere in this repository** — not in an ADR,
not in the specs, not in a code comment. Meanwhile `Document.extractedText` is arbitrary text from
arbitrary incoming post, and the Receptionist's whole job is to read it.

The honest assessment is that we are protected, but mostly by accident of scope, and one of the
protections is prose:

- **What holds.** The Receptionist reads the untrusted text and holds no dangerous Tool: it can
  read, search, create and update Things, ask the User, request a transcription, and call the
  Accountant. It has no bank Tool and no Bookkeeping Tool. `bookkeeping.postTransaction` lives on
  the Accountant, reachable only through `assistant.call`. An Assistant cannot grant itself a Tool,
  because the store refuses the Runtime `ASSISTANT_WRITE`. Nothing an injected instruction can say
  changes any of that — which is ADR-0010 doing exactly the work it was written to do.
- **What does not hold.** The Accountant's instruction *"Ask the User to approve the booking …
  Never book without an explicit yes"* is a **system prompt, not a mechanism**.
  `bookkeeping.postTransaction` is granted and callable on any Turn. ADR-0012 guarantees the same
  booking cannot land twice; nothing guarantees a *first* booking was approved. The end-to-end tests
  script a model that chooses to ask, so they prove the suspend-and-resume machinery, not the rule.

So the sharpest finding on our own side is not the Schedule Trigger after all:

> **At the one boundary where money moves, our safety property is written in prose.** The system's
> promise is that nothing is booked without an answer. That promise is currently kept by the model
> following instructions, not by the Runtime refusing.

The fix is small and fits the existing grain: make an Operation able to declare that it requires an
answered Open Question in the same Conversation before it may execute, and let
`bookkeeping.postTransaction` declare it. It is the same shape as ADR-0010's other refusals — a
declaration rather than a prompt — and it is checkable in `advance()` where the intent is already
being written. It also composes with §1: the Operation would answer `pending` when the approval is
missing, which is a path the loop already has.

We do not need `origin_class`, because we have no durable memory for a payload to sit in — our
Conversations are episodes and nothing is consolidated into an instruction file overnight. What we
should take from their design is the principle underneath it: **decide structurally which text is
allowed to become an instruction, rather than trusting a prompt to hold the line.**

---

## A channel is a Connector, not a control plane

This is the reframing that makes OpenClaw's most visible feature buildable here without touching
the architecture.

OpenClaw's gateway must own channels: it holds the exclusive connection — for WhatsApp, exactly one
per host — normalises the payload into structured facts about sender, conversation, route and
reply plan, resolves the session and routes the answer back. That is a control plane, and it is why
the gateway exists. Their plugin interface is correspondingly serious: four required fields and
some thirty-five optional adapter surfaces, with a deliberately closed vocabulary of message
actions that plugins may extend only by core pull request.

We need none of it, because a question is already a **Thing**. `ui.askUser` writes an Open Question
and the Conversation stops. Anything at all can render that question and write the answer back; the
Runtime notices on its next scan and cannot tell what rendered it. The A12 web application is
simply the renderer we have.

So "add Telegram" in our shape is:

- a **Connector** that posts an unanswered Open Question to a chat and returns the reply;
- no gateway, no channel registry, no session routing, no normalised envelope, no second authority
  for pending work;
- and — the part that makes it worth doing — it composes with **Manual Connectors** for free.
  *"Send this email and tell me when you have"* is already an Open Question of kind `perform`. On
  Telegram it is a message you can answer from a train.

One thing such a Connector must get right, and it is not obvious:
[ADR-0014](../../docs/adr/0014-exactly-one-runtime-replica.md) gives the Open Question **one writer after
creation, the User**. A connector inside the Runtime that stamped the answer onto that document
would be a second Runtime write to a document the User may be editing — the exact hazard that moved
answer *consumption* onto the Conversation in the first place. So the answer must arrive either as
the User, or as an Entry on the Conversation the Runtime already owns. That is a real decision, and
it is the only part of "add a channel" that is not already solved.

Two further things to carry over, both learned from their mistakes: a channel must treat the sender
name as **untrusted text** (Selma concatenates a Telegram display name straight into the agent's
input, which is an injection vector by itself), and outbound delivery must be **awaited and
error-checked** rather than fired and forgotten. **(Selma)**

And one sobering data point before anyone assumes channels are cheap: of OpenClaw's twenty-six
channel integrations, exactly **one** — Discord — is rated stable by the project's own maturity
taxonomy. Telegram, WhatsApp, Slack and iMessage are beta; everything else is alpha or
experimental, and the channel framework itself is beta.

---

## What we should learn

Ranked, with a verdict, what it costs and what it would need.

| # | Learning | Verdict | Cost | Needs |
|---|---|---|---|---|
| 1 | An Operation may declare that it requires an answered Open Question before it executes — so "nothing is booked without an answer" stops being prose | **Adopt** | Small; `advance()` already writes the intent there | An ADR. The sharpest finding in this document |
| 2 | A Schedule Trigger needs its own exactly-once identity — `(assistantKey, scheduledFor)`, keyed on the *due instant* | **Decided** — [ADR-0016](../../docs/adr/0016-a-schedule-fires-on-its-due-instant.md) | Small | The watcher's seventh scan, and one indexed field |
| 3 | A channel is a Connector for the UserInterface, not a gateway | **Adopt** (as the design) | A Connector to build | Nothing new — it is already the shape |
| 4 | Enforce the single Runtime instead of asserting it | **Decided** — [ADR-0017](../../docs/adr/0017-the-runtime-claims-ownership-and-stands-down.md) | Small | An owner stamped beside the heartbeat |
| 5 | Auto-disable a Schedule after N consecutive failures | **Adopt** with (2) | Trivial | `Assistant.enabled` already exists; nothing sets it |
| 6 | Record token usage on the Turn | **Adopt** | Two fields; both providers already receive it | A model change |
| 7 | A scheduled Conversation that finds nothing must be quiet by construction | **Adopt** with (2) | Free — a convention in the Assistant's prompt | Nothing |
| 8 | Active hours on a Schedule, with equal start/end meaning *never* | **Adopt** with (2) | Trivial | Same ADR |
| 9 | Compaction as a **Turn-boundary step recorded as an Entry** — never a background task | **Adapt, later** | Medium | The `maxTurns`-reached path exists to hang it on |
| 10 | Progressive disclosure of Skills — inject an index, let the model fetch the body | **Adapt, later** | Medium; needs a `skill.read` Operation | Both OpenClaw and Selma do this. Worth it past ~10 Skills on one Assistant; the most any of ours has is 3 |
| 11 | Keep the system prompt stable-first, volatile-last, and say so | **Adopt** | Free | We already are. The learning is to *keep* it when something time-varying is added |
| 12 | A transcript **view** in the UserInterface | **Revisit** | This is the D-005 trade, taken deliberately | Its own change |
| 13 | Markdown skills discovered from a folder | **Reject** | — | Skills are fields on an Assistant Thing (ADR-0009). A folder is a second authoring path |
| 14 | A shared or installable skill library | **Reject** | — | ADR-0009 forbids it. Their hub needed a security scanner; a field needs nobody |
| 15 | A gateway process as the control plane | **Reject** | — | ADR-0011. It would be a second place to ask "is there work?" |
| 16 | OpenTelemetry export | **Reject** | — | ADR-0006. The real need is (12) |
| 17 | Full system access, an `exec` tool, or self-applying learned skills | **Reject** | — | ADR-0010's granularity is the whole point |

Three cautionary findings — things to make sure we never start doing:

- **Never classify an error by matching prose.** Selma decides a context overflow happened by
  substring-matching the model's own reply for "context window", so asking it what its context
  window is triggers a false overflow, a memory flush, three retries and an error instead of the
  answer. Our failure policy tiers on transport status and finish reason, which is why this cannot
  happen here. **(Selma)**
- **Never let a background task mutate the running context.** Selma's proactive compaction is a
  fire-and-forget task fired from inside context-building; it races the loop, can rewrite the
  message list mid-turn, and its exceptions are unobserved. If we add compaction, it is a step *in*
  a Turn and an Entry *in* the transcript. **(Selma)**
- **One source for what a model may call.** Selma derives the advertised and executable tool lists
  separately and they drift, so a misspelling leaves a tool advertised but uncallable. Ours derive
  both from `grantedTo`, with a belt check at execution and a test for it. Keep the belt. **(Selma)**

---

## Where our concepts are stronger

For *this* system's purpose — unattended household admin under supervision. Several would be
over-engineering in a personal chat agent.

1. **Waiting is free, and it is a modelled state.** An Assistant that has asked a question holds
   nothing; the question *is* its state. Three weeks and any number of restarts cost nothing, and
   "everything waiting on the User" is one indexed query. OpenClaw gets the statelessness by
   accident of the loop ending; it does not get the queryable pending state, and it cannot suspend
   inside a tool call at all.
2. **Every tool call is potentially suspending.** A human-paced Operation is expressible. That one
   generalisation is what turns a coding-agent loop into ours.
3. **The intent log and keyed idempotency.** Nothing of the shape appears in Selma, nor in the three
   systems [AGENTIC_LOOP.md](AGENTIC_LOOP.md) surveyed. It is the difference between a crash and
   booking €96.50 twice.
4. **One Authority per fact.** No cached foreign facts, therefore no lies to reconcile. Their memory
   is a retrieval index over what was written down; ours is a query against whoever owns the truth.
5. **Tool permission the agent's own process cannot grant itself**, enforced by the store rather
   than by policy code running beside the model.
6. **Exactly-once birth as a query, not a heuristic.** Survives restart, re-scan and a replayed
   watermark — for Triggers that have a subject Thing, which is the caveat §6 is about.
7. **Nothing ends silently**, with the meta-rule that the escalation path shares fate with the
   failures it reports. One place for the User to look, and it is the same place as everything else.
8. **Bounds on an LLM loop with a credit card**: `maxTurns`, a births-per-hour cap, a
   trigger-eligible allow-list that structurally prevents feeding on our own output, `enabled`, and
   a global pause. Selma's loop has *no* turn cap and *no* token budget. **(Selma)**
9. **The Assistant is a governed Thing, not a folder.** Prompts, Skills, Triggers and Tools are
   fields on a modelled document with a form ([ADR-0003](../../docs/adr/0003-assistants-are-things.md)).
   Selma's equivalent is seven markdown files plus a JSON config — and its installer writes
   `MEMORY.md` to a path the loader does not read, so the curated memory never reaches the prompt.
   A modelled field cannot be in the wrong place. **(Selma)**
10. **The vocabulary is enforced.** [CONTEXT.md](../../CONTEXT.md) lists forbidden synonyms per term. That
    is why "waiting" means one thing in the models, the code and the prose.
11. **No durable memory is also a security property.** Their hardest problem — a payload sitting in
    memory for weeks — cannot happen to a system whose Conversations are episodes and whose facts
    live with their Authority. We got that for free, and §7 is about not squandering it.

---

## Where they are stronger

Stated plainly, because a comparison that only flatters is useless.

1. **Reach.** They meet the User on the messenger already open. We require a web application on
   localhost. For a system whose entire value is a question getting answered, that is the difference
   between a two-second answer and a three-day one.
2. **Proactivity exists**, with quiet hours, backoff and auto-disable. Our Schedule Trigger is a
   field name.
3. **Memory across runs.** An Assistant of ours starts each Conversation knowing nothing it cannot
   look up.
4. **Compaction.** A months-long Conversation will need it, we know it, and we do not have it.
5. **Streaming.** Both our providers are single non-streaming calls. Nothing watches a live run, so
   nothing has demanded it — but it is why the system feels like a batch job.
6. **A security programme.** A published threat model that rates its own worst case *Critical*, a
   named exclusion policy, a CVE history and third-party scrutiny. We have none of that, and §7 is
   the first paragraph of it.
7. **Extension without ceremony.** Drop a `SKILL.md` in a folder. Adding an Operation here is
   TypeScript; adding a Model is a nine-step checklist.
8. **Provenance on remembered text.** `origin_class` and `session_kind` are a better answer to
   "which text may become an instruction?" than anything we have written down.

And two things stronger in *their* context that we should still not copy: full system access (their
reach depends on it; ours would be an unbounded Tool grant), and runtime-installable skills (their
breadth depends on it; ours would be a second authoring path around ADR-0009 and ADR-0003, and it
is what needed a scanner).

---

## The thing to take away

OpenClaw and Assistants both concluded that the store is the truth and the loop holds nothing. That
convergence is real and, as [AGENTIC_LOOP.md](AGENTIC_LOOP.md) already found across three other
systems, it appears to be the shape of the problem rather than anyone's taste.

They then diverged on one question: **who owns "what is pending?"** OpenClaw answers *the gateway* —
a live process that routes, authenticates and executes. We answer *the store* — pending work is a
query, and nothing is entitled to answer it but the Authority. Their answer buys reach: twenty-six
channels, a scheduler, a skill market, a presence. Ours buys the ability to stop for three weeks in
the middle of a payment and be exactly where it was.

The two findings worth keeping are both about us, and both are the same shape. Our exactly-once
birth is a query that a Schedule Trigger cannot ask. Our promise that nothing is booked without an
answer is a sentence in a prompt rather than a refusal in the Runtime. In each case the system's
strength — *the structure enforces it, so we need not trust the model* — has a gap exactly where
nobody has looked yet.

---

## What could not be verified

- **The article is ten weeks out of date on its own subject.** OpenClaw dropped Pi's agent core on
  2026-05-28 and now runs an in-house runtime, keeping only `pi-tui`. That the in-house packages
  *replaced* those roles is an inference from where they sit in the tree; that they exist and Pi's
  are gone is verified from the published package history.
- **Line counts are dated, and the article's is not supportable.** The ~3.9M non-test figure is a
  measurement of HEAD on 2026-08-11 by two methods agreeing to 0.3%. No primary source for the
  article's "350,000" was found; circulating figures range 270k–1M and none carry a date. Any LOC
  number for this project without a date is meaningless, including this one in six months.
- **Skill-hub scale is contradictory and deliberately not cited.** The hub's own homepage and its
  API disagree by three orders of magnitude, and the discrepancy was not reconciled. The article's
  "over a hundred community skills" is therefore neither confirmed nor contradicted here.
- **Selma's claims are source-read, not run.** Nothing was executed. The bugs cited are static
  findings. Selma is a declared toy and is used above only where it makes a concept concrete — it
  is not evidence about OpenClaw's engineering.
- **Selma is not the current line either.** Its own `pyproject.toml` points at a successor,
  `gkvoelkl/python-selmakit`, which reportedly adds scheduling decorators, MCP with approval gating
  and sub-agent delegation.
- **Pi was read once, not again here.** Its `Agent`/`AgentSession` split, `subscribe`, `steer()`,
  `followUp()`, JSONL sessions with `parentId`, compaction with a retained tail, and `branch(id)` on
  the `SessionManager` are as recorded in [AGENTIC_LOOP.md](AGENTIC_LOOP.md) on 2026-08-09 and were
  re-confirmed against the repository, which is
  [earendil-works/pi](https://github.com/earendil-works/pi) — not `badlogic/pi`, which is an
  unrelated project.
- **The security findings are third-party publications**, summarised rather than reproduced. No
  attack was attempted against anything. The claim that *our* Accountant can book without an
  approved Open Question is ours and is read from `runtime/src/bootstrap/assistants.ts` and
  `runtime/src/tools/tools.ts`; it has not been demonstrated with a live model.
