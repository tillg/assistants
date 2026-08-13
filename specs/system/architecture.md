# Architecture — how the system is built

The domain this realises is in [domain.md](domain.md); the vocabulary is in
[CONTEXT.md](../../CONTEXT.md). [README.md](../../README.md) is the operator's view — how to run
it, and what every `just` recipe does — and is not repeated here. The twenty decisions with
their alternatives and reversal costs are in [docs/adr/](../../docs/adr/), and the running record
of decisions taken while building is [DECISIONS.md](../../DECISIONS.md).

## Overview

One `docker compose` file: seven long-running services and two one-shot init containers. No second
database engine, no message broker, no workflow engine, no queue.

```mermaid
flowchart LR
    subgraph compose["docker compose"]
        direction TB
        PG[("postgres :8083<br/>4 databases")]
        KC["keycloak :8089<br/>identity provider"]
        SRV["server :8082<br/>A12 Data Service<br/>= ThingStore"]
        INIT["server-init<br/>one-shot: schema + models"]
        FE["frontend :8081<br/>A12 web app<br/>= UserInterface"]
        RT["runtime<br/>trigger watcher + loop driver"]
        FP["firefly-proxy :8084<br/>oauth2-proxy"]
        FF["firefly<br/>Firefly III = Bookkeeping<br/>no published port"]
        FB["firefly-bootstrap<br/>one-shot: token"]
    end
    LLM["LLM API<br/>scripted by default"]

    INIT --> PG
    SRV --> PG
    FF --> PG
    KC --> PG
    FE -->|"/api, /cs, /actuator"| SRV
    RT -->|JSON-RPC| SRV
    RT -->|REST| FF
    RT --> LLM
    FB --> FF
    FP -->|"X-Forwarded-Email"| FF
    SRV -.->|"verify the token"| KC
    RT -.->|"get a token"| KC
    FP -.->|"OIDC"| KC
```

The architectural style is not microservices and not a monolith. It is **one shared store with two
independent clients**. The ThingStore is the only integration surface in the system: the
UserInterface writes to it, the Runtime polls it, and neither knows the other exists. There is no
service-to-service call anywhere in the product code.

Every host port is published on `127.0.0.1` only.

### Why the Runtime is a separate service

The A12 Data Service is a platform component we *configure*, not an application we own — its jar
comes from the registry and the project adds only a handful of Java classes. Putting a
long-running agentic loop, an LLM client and an HTTP connector inside it would fuse the
application's lifecycle to the platform's and make every Runtime change a Spring Boot rebuild.

Keeping it outside also keeps the ADR-0006 boundary honest: the Runtime is a *client* of the
ThingStore with no privileged access, exactly like the UserInterface.

### Why the Runtime polls (ADR-0011)

The Runtime offers no API and receives no webhooks. It asks the store every two seconds what has
materialised, what has been answered and what is due to wake.

The ThingStore is the Authority for Conversations and Open Questions, so "is there anything to
do?" is a question about the store and nothing else is entitled to answer it. An API on the
Runtime would be a second place to ask, and it would hold in memory — a pending request, a
subscription, a callback — exactly the live state ADR-0004 exists to remove. The cost is a handful
of indexed queries every two seconds and a latency of one scan interval. At one household's volume
that is free; at another scale the interval is the first thing that would have to give.

## Technology stack

| Layer | Choice | Role |
|---|---|---|
| Platform | **A12** 2026.06, local-auth project template | Models, Data Service, form/overview engines, the web application |
| ThingStore | A12 Data Service (Spring Boot, Java 21) | Stores every Thing; JSON-RPC at `/api/v2/rpc` |
| UserInterface | A12 web application (React, TypeScript) | Generated from the models, plus the lifted markdown editor |
| Runtime | **TypeScript on Node 24** | Trigger watcher and loop driver |
| Database | **PostgreSQL**, one container, four databases | `assistants-ds`, `assistants-cs`, `assistants-firefly`, `assistants-keycloak` |
| Identity | **Keycloak 26**, realm `A12Realm` | The only thing in the system that checks a password |
| Bookkeeping | **Firefly III 6.6.6** | The books; the Authority for accounts, transactions, balances, budgets |
| Firefly access | **oauth2-proxy** | Firefly has no OIDC client; the proxy runs the flow and forwards a header |
| Editor | **Lexical** | The markdown editor, lifted from `w12-on-a12` |
| Build | **Gradle 9.5** / **npm** / **just** | `just` is the single command surface |
| Tests | **vitest**, **Playwright** | Four tiers plus an opt-in live-LLM tier |

The Runtime is TypeScript because the LLM SDKs are first-class there, the repository already
carries a Node toolchain for the A12 client, and the loop is I/O-bound orchestration rather than
computation.

A12 artefacts resolve from the **public** community registries pinned in `.npmrc` and
`settings.gradle`, so the build needs no VPN and no credentials (D-006).

## Repository layout

The A12 project template's shape is kept at the repository root — deviating from it would fight
every Gradle task the template provides.

```
/
├── justfile                  the command surface; every recipe documented in README.md
├── client/                   the A12 web application = UserInterface
│   └── src/components/markdown-editor/   lifted from w12-on-a12
├── server/                   the A12 Data Service = ThingStore (app/ and init/)
├── runtime/                  the Runtime (TypeScript)
│   ├── src/a12/              JSON-RPC client + typed Thing repository
│   ├── src/llm/              provider interface + openai / anthropic / scripted
│   ├── src/loop/             advance() — one Conversation, one Turn
│   ├── src/watcher/          the seven scans
│   ├── src/operations/       the registry and the seventeen Implementations
│   ├── src/connectors/       firefly
│   ├── src/bootstrap/        seeds the two Assistants, the catalogue and the RuntimeState singleton
│   ├── src/demo/             the demo household loader
│   └── fixtures/             the scripted LLM transcript
├── import/
│   ├── models/               the nine Things (DM/FM/OM) + the application model + CONVENTIONS.md
│   ├── auth/                 roles.yaml — realm role → A12 access rights
│   └── validate-models.mjs   the model validator
├── compose/                  docker-compose.yml, firefly/, postgres/, keycloak/
├── e2e/                      Playwright
├── scripts/                  setup-env.mjs, check-docs.mjs
└── specs/, docs/adr/, CONTEXT.md, DECISIONS.md, README.md
```

## Components

### ThingStore (`server/`, `import/models/`)

An A12 Data Service holding every Thing and exposing A12's JSON-RPC interface. Nine Models, each
with a document model (`_DM`), a form model (`_FM`) and an overview model (`_OM`), plus one
application model (`_AM`) for navigation and one query model (`OpenQuestionPending_QeM`).

Form models bind **directly** to their document model (`purpose: "data binding"`) — there is no
composed-document layer, because references between Things are plain ThingID strings.

#### Four modelling rules the query API forces

The A12 query API is narrower than it looks, and the watcher's scans are the system's hot path.
These are applied at model-design time rather than discovered later; the full cookbook is
[`import/models/CONVENTIONS.md`](../../import/models/CONVENTIONS.md).

1. **Every machine-filtered field is a `String` carrying a code, never an `Enum`** — A12 indexes
   enumerations by localised display text.
2. **Never filter on a path inside a repeating group.** Anything the watcher needs is a top-level
   scalar; the Assistants are loaded whole and their `triggers[]` matched in the Runtime.
3. **Every watcher-filtered field carries the `indexed` annotation.** Only indexed fields are
   queryable at all.
4. **Every Model carries its own `createdAt` / `updatedAt` / `idempotencyKey` /
   `createdByConversationId`.** `__meta.createdAt` has second granularity with inclusive range
   bounds, which double-counts the watermark boundary.

The one pattern worth naming, because it is used twice: "set but not yet processed" is
`and(not(undefined_match(x)), undefined_match(y))`.

A consequence worth knowing: `updatedAt` records the last **Runtime** write. A save from the web
application moves only `__meta.modifiedAt`, because the four machine fields are on no form and
A12's form engine offers no save hook that could reach one.

### UserInterface (`client/`)

The A12 web application, generated from the models, with one addition: the **markdown editor
lifted from `w12-on-a12`** (`client/src/components/markdown-editor/`, Lexical-based), with the
collaborative-editing subsystem and the CDD-coupled inline-attachment path dropped.

A field becomes a markdown field by three coordinated facts:

1. `lineBreaksPermitted: true` on the `StringType` in the `_DM`;
2. `"exposition": "AREA"` in the `_FM`'s `fieldConfiguration`;
3. `{"name": "widget", "value": "markdown-editor"}` on the `_FM` Control.

Wiring is a `formModelMap.Control` bridge plus a `widgetMap.TextAreaStateless` entry in
`client/src/appsetup.ts`. This uses native A12 features only, which is what makes an Assistant's
prompts editable in the ordinary UI as ADR-0003 requires. See
[MARKDOWN_FIELDS.md](../research/MARKDOWN_FIELDS.md).

**Constraint**: `lexical` must resolve to a single instance shared with `widgets-core`, or
Lexical's `$`-functions break. Verified in the build with `npm ls lexical`.

There is no custom client code beyond this. The User answers an Open Question by opening it in the
ordinary A12 instance form and saving it (D-005).

**If a Thing is ever reached outside the web application — a messenger, a push notification, mail —
it hooks `raiseQuestion` and nothing else.** Every Open Question in the system passes through that
one function: `ui.askUser`, every Manual Connector, every escalation, and every approval refusal.
`ui.askUser` looks like the natural hook and is the wrong one — it misses all of those but the first,
which is to say it misses precisely the questions worth pushing to a phone. Such a notification must
also be **non-fatal**, because [ADR-0015](../../docs/adr/0015-nothing-ends-silently.md)'s rule that
the escalation path must not share fate with the failures it reports cuts both ways: a dead channel
must never fail a Conversation. Nothing does this today, and the decision is recorded here rather
than in the change that declined to build it.

### Runtime (`runtime/`)

Two halves, roughly 6,900 lines of TypeScript.

```mermaid
flowchart TB
    subgraph RT["Runtime"]
        W["Trigger Watcher<br/>watcher.ts<br/>seven scans, every 2s"]
        L["Loop Driver<br/>advance.ts<br/>one Conversation, one Turn"]
        TR["Operation registry<br/>registry.ts + implementations.ts<br/>17 Implementations, joined to<br/>the catalogue per Turn"]
        C["A12 client + Thing repository<br/>a12/client.ts, a12/things.ts"]
        P["LlmProvider<br/>openai | anthropic | scripted"]
        FFC["Firefly connector<br/>connectors/firefly.ts"]
        H["health.ts<br/>heartbeat freshness"]
    end
    W --> L
    L --> TR
    L --> P
    TR --> C
    TR --> FFC
    W --> C
```

#### The loop driver

One function with no state of its own. Everything it needs it reads from the Conversation;
everything it learns it writes back before returning.

```
advance(conversationId):
    conv = thingStore.get(conversationId)
    if conv.status not in (running, waiting) or not claimLease(conv): return
    if conv.turnCount >= assistant.maxTurns: raiseTerminal(conv, 'limit'); return
    catalogue = thingStore.search(Operation_DM)   # ← ONE SNAPSHOT, ONCE PER TURN
    if catalogue is empty: throw                  # bootstrap has not run; the Turn is not spent
    context = buildContext(conv)              # system prompt + skills + entries
    response = llm.complete(context, registry.schemasFor(assistant, catalogue))
    append(conv, response); conv.turnCount++
    if response.finishReason != 'wants-tools':
        finish(conv)                          # done, or deliver the result to the parent
        write(conv); return
    for call in response.toolCalls:
        key = conv.id + ':' + nextSeq(conv)
        append(conv, intent(call, key))
        write(conv)                           # ← INTENT IS WRITTEN BEFORE EXECUTION
        hash    = canonicalArgsHash(call.args) if call.operation.requiresApproval else none
        refusal = gateOnApproval(conv, call, hash) if hash else none
        result  = refusal or operations.execute(call, conv, key)   # ← APPROVED BEFORE IT RUNS
        if result.pending:
            conv.status = 'waiting'; conv.waitingFor = result.waitingFor
            conv.wakeAt = result.wakeAt
            write(conv); return               # the process now holds nothing
        entry = append(conv, toolResult(call, result))
        if hash and not refusal and result.kind == 'value':
            entry.argsHash = hash             # the approval is spent by a call that RAN
    write(conv)
```

Five properties are load-bearing:

1. **One call, one Turn.** `advance` never loops internally. Continuing is re-entry through the
   same door birth uses.
2. **The pending path is the normal path.** Every Operation may answer `pending`. That single
   generalisation is what turns a coding-agent loop into this one. Coding agents assume tools
   return in seconds and block inside the Turn; here the Operations are human-paced by design.
3. **The Conversation is an intent log, not a result log** (ADR-0012). The intent, including its
   idempotency key, is written *before* the Operation runs.
4. **The approval gate sits between the two.** Its position is not incidental: after the intent, so
   a refusal is visible in the transcript rather than inferred from an absence; before execution, so
   there is nothing to undo. See below.
5. **One catalogue per Turn.** The Operations the model is offered and the Operations it is then
   allowed to run are resolved from the *same* snapshot, read once at the top of `advance()`, so a
   User editing the catalogue mid-Turn cannot produce a Turn whose schemas and executions disagree.
   An empty catalogue is refused rather than defaulted to the Implementations' seeds — a fallback
   would be a second answer to *"what can this Assistant do"*, in the one place where the wrong
   answer costs money — and refusing before the provider is called means the Turn is not spent, the
   lease lapses, and the next scan retries.

Where a Turn's cost is recorded is a consequence of this shape. A Turn that ends `wants-tools`
appends no `assistant` Entry at all — only one `tool-intent` per call — so "the Turn's assistant
Entry" names a row that does not exist for most Turns. The rule is therefore **the first Entry the
Turn wrote**: the `assistant` entry for a text reply, the first `tool-intent` otherwise.

#### Approvals (ADR-0018)

An Operation may declare `requiresApproval`, and the Runtime refuses to run it without an answered
confirmation that **the Runtime itself** raised, for that Operation, with those exact arguments, in
that Conversation. `bookkeeping.postTransaction` is the only Operation seeded with it today, and
since the catalogue moved into the store the flag is read from the Operation **Thing** — the
Implementation's value is what the Thing was created with and nothing more, so the User may add a
requirement where the code demands none and remove one it does demand. A weakening is logged once
per Operation per process, named, and not overridden (ADR-0019, and the amendment on ADR-0018). The
domain rules are in [domain.md](domain.md); what belongs here is the mechanism, which is three small
additions and one walk-back.

The arguments arrive as the model produced them, so neither key order nor number formatting is
stable. `canonicalArgsHash` hashes a canonical form — keys sorted, numbers normalised — and that
hash is what the approval is bound to. Nothing forces the model to re-issue *identical* arguments
after the yes, so a drifted call misses its approval and the User is asked again: visible and safe,
never a wrong booking.

Recognising an approval in the transcript needs something machine-readable, because **the prose is
never parsed** — substring-matching a model-facing string is a failure mode
[the comparison document](../research/ASSISTANTS_VS_OPENCLAW.md) names as one never to start. So
`Entry` gains `questionId`, set by scan 2 on every `answer` entry it appends and read only by
approvals, and a `kind: "approval-request"` Entry carries `toolName`, `argsHash` and `questionId`.
That entry deliberately carries **no `text`**: `buildMessages` maps an unknown kind with a `text` to
a *user* message, which between a tool call and its result is a shape Anthropic rejects outright.
It is machine-readable only, and the model learns of the refusal from the pending tool-result.

`findApproval` then walks back over those two kinds and reads one Open Question by id:

```
find the last approval-request for (toolName, argsHash)
  → no such request                                          → refuse, and raise one
  → its answer entry is absent                               → refuse, still waiting
  → its question is not confirmed: true                      → decline, terminal
  → a tool-result carrying this argsHash follows the answer   → refuse, consumed — raise a fresh one
  → otherwise                                                → execute
```

Three details in that predicate are each a bug that was either avoided or found and fixed:

- **Spent means executed, not attempted.** The `argsHash` is stamped onto the *tool-result* too, and
  only where the Operation ran and returned a value — including on the reconciliation path, so a
  booking that turns out to have landed still spends its approval and two identical bookings still
  need two approvals (ADR-0012). Keying consumption on "a tool-result for this Operation" instead
  would let a Firefly 422, after which nothing was booked, consume the approval — and the retry that
  `postTransaction`'s own description invites would ask the User a second time for a booking that
  never happened.
- **Anything short of an explicit `true` is a no.** `isAnswered` is deliberately generous, so a User
  who types a sentence and leaves the tri-state Boolean unset has *answered* and the Conversation
  resumes. Treating that as "still waiting" would loop until `maxTurns`; treating it as a fresh
  refusal would re-ask, which the domain rules forbid. The model is told which it was, so a User who
  meant yes and forgot the tick can see why nothing happened.
- **The refusal uses `raiseQuestion`, never `escalate()`.** A missing approval is the ordinary path,
  not a stuck Conversation; going through `escalate()` would increment `escalationCount` and three
  unapproved bookings would mark the Conversation `failed`. It returns `pending` waiting on the User
  with **no `wakeAt`** — an unanswered approval waits, it does not lapse into a booking — and the
  note tells the model *refused pending approval, not queued*, because the generic suspension
  wording would tell it the booking is on its way.

The question's idempotency key is `approval:<conversationId>:<argsHash[0:16]>:<attempt>` rather than
the entry's sequence number: the question is created *before* the `approval-request` Entry recording
it, so a crash in between leaves an orphan, and a sequence-derived key would mint a second question
on the retry while the first sat unanswered forever. Derived from the arguments, the retry computes
the same key and `create` adopts the orphan.

How the question reads is `describeCall` on the Operation, because this question is the entire
user-facing surface of *"nothing is booked without an answer"*. The Runtime adds the **Approval
needed.** framing; an Operation without a renderer falls back to a fenced JSON block, which exists so
the check never blocks on a missing renderer and is not the intended experience — a JSON blob in the
inbox is how a safety feature becomes a thing the User clicks yes on without reading.

#### The trigger watcher

A scan every two seconds. It does nothing at all while `RuntimeState.paused` is true, and nothing at
all while the catalogue is empty: before its first scan the watcher reads `Operation_DM`, and an
empty or unreadable catalogue is logged at error with its remedy (`just bootstrap`), reported as
unhealthy, and re-checked on every scan — so a stack brought up before it is bootstrapped says what
is missing, heals when it arrives, and logs the transition rather than quietly starting to work.

| # | Scan | Action |
|---|---|---|
| 1 | Trigger-eligible Things created after the watermark with no Conversation on `(assistantKey, subjectThingId)` | birth |
| 2 | Conversations `waiting` on `user` whose `currentQuestionId` resolves to an answered `OpenQuestion` | append the answer, continue |
| 3 | Conversations `waiting` with `wakeAt` in the past | append a timeout entry, continue |
| 4 | Conversations `running` with `leaseUntil` in the past | recover per the intent log, continue |
| 5 | Conversations `done` with a `parentConversationId` and no `resultDeliveredAt` | deliver to the parent, stamp, continue |
| 6 | Conversations `running` that simply owe their next Turn | continue |
| 7 | Enabled Assistants whose `schedule` Trigger's latest due instant has no Conversation on `(assistantKey, scheduledFor)` | birth |

Scan 1's exactly-once guarantee is two indexed `exact_match`es on `(assistantKey,
subjectThingId)`. It subsumes — but does not replace — the rule that nothing is birthed from a
Thing whose creating Conversation is still running.

Scan 2 is where the single-writer invariant could have been lost. The obvious mechanism —
stamping `consumedAt` on the `OpenQuestion` — would give that document a second Runtime write
while the User may still be editing it. So consumption happens on the **Conversation**, which the
Runtime owns exclusively: continuing clears `waitingFor`, and the Conversation therefore stops
matching the scan. This also disposes of the User re-editing an answered question, of a late child
result, and of an answer whose `seq` is behind the Conversation's position — three cases, one
shape: append it as an entry and change nothing.

**Scan 7 is the only scan whose input is configuration rather than the store** ([ADR-0016](../../docs/adr/0016-a-schedule-fires-on-its-due-instant.md)).
It reads `cron` off each enabled Assistant's `schedule` Triggers, resolves the **latest** due instant
in `SCHEDULE_TIMEZONE`, and births a Conversation carrying it as `scheduledFor` unless one already
exists. Only ever evaluating the latest instant is what makes three properties fall out of the
mechanism rather than out of code here: exactly-once across a re-scan, a restart and a replayed
watermark; catch-up **once** rather than once per missed slot; and no watermark at all — a mark
written *after* the work is what ADR-0012 exists to avoid, and a schedule that chased an insurer
would chase them twice.

A slot is **skipped entirely while an earlier one for the same Assistant is unfinished**, so a
Schedule stalls rather than accumulates. That is also why nothing here disables an Assistant: there
is no runaway to bound, and a stall already has the unanswered Open Question that caused it sitting
in the User's inbox. Repeated skipping is a log warning, the way a pinned watermark is.

Daylight saving is the only genuinely hard part, and it is `latestDueInstantBefore` in
`runtime/src/watcher/schedule.ts` that owns it: `cron-parser` does the arithmetic, and the wrapper
decides that the autumn wall-clock slot which happens twice is **one** slot (collapsed onto its first
occurrence, so the second recomputes to a `scheduledFor` already served) while the spring slot that
does not exist simply never appears. An unparseable `cron` is a configuration error on a Thing the
User owns: it is logged once per Assistant per process and the Trigger is skipped.

**Stable-first, volatile-last.** `scheduledFor` is the first time-varying value in this system to
reach a prompt, and the rule that was true by accident is now written down: the standing half of a
prompt comes first, anything that changes per Conversation comes last. Free, and only free before
something breaks it.

#### Idempotency and recovery

> **Every Operation is either read-only or idempotent under a caller-supplied key. No Operation
> may be both mutating and unkeyed.** Where the Authority offers no unique constraint, keyed
> idempotency is achieved by **search-then-act**.

The key is `<conversationId>:<entrySeq>` — deterministic across a re-run of the same Turn.
Recovery finds an intent entry with no matching result and *asks the Connector whether that key
landed*; it never re-executes blind.

- **Firefly**: the key goes in `external_id`; recovery is an `external_id_is:` search, with
  `error_if_duplicate_hash` as a belt. Separately, the Invoice's ThingID travels as the tag
  `thing:<thingId>`, which is what lets the Connector recognise a posting already made from a
  *different* Turn or Conversation — the key cannot answer that, and the tag can.
- **ThingStore**: `ADD_DOCUMENT` assigns the docRef, so the client cannot choose an identifier.
  Hence the `idempotencyKey` field on every Model, and `thingstore.create` is defined as
  *search-then-create*. One extra query per create, and the same primitive makes the demo loader
  re-runnable.
- **Manual Connectors**: the key is carried on the `OpenQuestion`, so a re-run finds the question
  already asked rather than asking twice.

#### The failure policy

| Tier | Examples | Response |
|---|---|---|
| **Transient** | LLM timeout, 429, 5xx | Bounded retry with backoff inside the Turn; each attempt recorded as an entry |
| **Recoverable by the model** | Malformed tool-call JSON, an Operation called that is not granted, is switched off or is no longer implemented, 422 from a Connector, a ThingStore validation error | Append the error **as a tool result** and let the next Turn see it. This is how the model self-corrects, and it costs nothing |
| **Terminal** | Retries exhausted, `maxTurns` reached, an Authority refusing repeatedly | **Never silent**: `status = waiting`, `waitingFor = user`, and an `OpenQuestion` of kind `perform` carrying the error. Capped at three escalations per Conversation |

Because the terminal tier shares fate with the failures it reports, `heartbeatAt` is stamped at
the end of every *successful* scan, a scan that throws deliberately leaves it untouched, and the
compose healthcheck fails once it is stale (ADR-0015).

#### Operations

An Operation is split in two (ADR-0019). The **Implementation** is code — `execute`, and optionally
`reconcile` and `describeCall(args)`, plus `mutating`, which is a claim about what `execute` does
and is never read back from data. The **Operation** is a Thing: its key, its System, its kind, the
prose the model reads, its parameter schema, whether it requires an approval and whether it is
switched on. The two are joined by the Operation's key, which is why the catalogue can describe an
Operation and cannot invent one. The product of the join — an Operation resolved for one Assistant,
with its Implementation bound in — is a **Granted Operation**, and that is the shape `advance()`
consumes.

**There is no table of Operations here any more, on purpose.** The one that used to open with
*"Seventeen Operations"* was a hand-maintained copy of a list that lives somewhere else, and it was
true on the day it was written. The catalogue is the answer now: open **Operations** in the web
application, or read `runtime/src/operations/implementations.ts` for the seventeen Implementations
that seed it. What a User wants from it — what does this Operation do, which System does it touch,
does it need my approval, is it on — is now an overview and a form rather than four questions for
whoever last read the source.

The registry resolves the Assistant's `grants[]` against a **catalogue snapshot taken once per
Turn**, and returns both halves of its answer: the Granted Operations, and the grants it dropped
with the reason for each — `absent`, `disabled`, `unimplemented`, `unparseable`, `self-call`,
`bare-call`. The schemas offered to the LLM are derived from the same call, so the advertised set
and the executable set cannot drift, and an Operation that is not offered is invisible rather than
merely refused. The dropped half is what lets the belt check at execution tell a model *why* — that
the Operation is switched off, or no longer implemented, rather than that it was never one of its
tools, which is false whenever the grant is still sitting in the Assistant's definition where the
User can see it.

**The Manual Connectors do not require approvals, and must not.** `bank.sendMoney`, `email.send` and
`document.requestText` already suspend with an Open Question, because the User *performs* them by
hand. An approval there would ask the User to approve doing something they are about to be asked to
do themselves.

What each seeded Assistant is granted is a property of the two Assistant seeds rather than of the
catalogue, so it is worth having here:

| | Receptionist | Accountant |
|---|---|---|
| Trigger | `thing-materialised` on `Document_DM` | `assistant-call`, and a `schedule` — `0 7 * * *` |
| ThingStore | `get`, `search`, `create`, `update` | `get`, `search`, `update` |
| `ui.askUser` | ✓ | ✓ |
| Bookkeeping | — | all five reads and `postTransaction`; **not** `createAccount` |
| Manual | `document.requestText` | — |
| Calls | `assistant.call:accountant` | — |

`bookkeeping.createAccount` exists and is granted to nobody, which is exactly the granularity
ADR-0010 argued for: the chart of accounts is a structural decision the User should be making.

#### The LLM provider

```ts
interface LlmProvider {
  complete(req: { system: string; entries: Entry[]; tools: ToolSchema[] }): Promise<LlmResponse>;
}
```

`OpenAiProvider`, `AnthropicProvider`, and `ScriptedProvider`, which replays
`runtime/fixtures/llm-script.json`. The choice is made by the **`LLM_PROVIDER` environment
variable on the compose service**, not only by a constructor argument — that is what lets the
end-to-end tier drive the *real* Runtime, ThingStore, Firefly and UI deterministically and for
free. `scripted` is the default (D-002).

`LlmResponse` carries an optional `usage: { promptTokens, completionTokens }`. Both real providers
already received it from their APIs and dropped it; they now return it, and `ScriptedProvider`
returns zeroes rather than nothing, so an absent field and a free Turn stay distinguishable. The
Runtime writes it onto the first Entry the Turn wrote, before the write that Entry needed anyway — no
extra store write, no running total on the Conversation, and nothing aggregates it. The transcript is
where you read it, which is the same argument as not building a second store for anything else.

### Bookkeeping connector (`runtime/src/connectors/firefly.ts`, `compose/firefly/`)

Firefly III on the stack's Postgres, in its own database under its own role, created by
`compose/postgres/db-init.sh`. A one-shot `firefly-bootstrap` container mints a personal access
token over Firefly's own web endpoints — no artisan command can do it — writing it to a shared
volume the Runtime reads.

The Connector **never passes `source_name` / `destination_name`.** Firefly auto-creates an expense
or revenue account when given a name it does not know, and the Accountant's job is precisely to
decide which accounts an invoice hits, *by emitting a name*. So `Expenses:Helth` would not fail —
it would succeed, silently creating a second account and corrupting a balance no test would catch.
ADR-0006 makes that worse rather than better: Bookkeeping is the Authority and nothing holds a
second copy, so there is no disagreement to detect. The Connector therefore resolves names to IDs
against `GET /accounts` (cached per scan); an unresolvable name comes back as a tool error, which
under the middle failure tier is appended as a tool result so the next Turn self-corrects against
the real chart.

## Data

### Databases

One Postgres container, four databases:

| Database | Owner | Holds |
|---|---|---|
| `assistants-ds` | A12 Data Service | The Things. Its own Liquibase changelog |
| `assistants-cs` | A12 Content Store | Binary content (attachments). Its own Liquibase changelog |
| `assistants-firefly` | Firefly III | The books |
| `assistants-keycloak` | Keycloak | The users |

The first two are A12's own split; Firefly and Keycloak own one outright each (D-004). There is no
second database *engine* — that was the point.

### Models

See [domain.md](domain.md) for what each Model means and who its Authority is. Structurally: nine
`_DM` / `_FM` pairs, nine `_OM`s, one `_AM`, one `_QeM` — twenty-nine models, which is the number
`import/validate-models.mjs` reports. This sentence used to say *seven* `_OM`s, and it was already
wrong before `Operation` was added: there were eight, one per Model, and there have been for as long
as every Model has had a navigation module. A count nobody can check by looking is a count that
rots, which is why the validator's total is quoted beside it.

Every Model ends its root group with the same four machine fields, in order: `idempotencyKey`,
`createdByConversationId`, `createdAt`, `updatedAt`.

### Attachments

A `Document` may carry a binary attachment, held in the A12 Content Store (`assistants-cs`). Text
extraction is **not implemented**: `extractedText` is supplied by whoever creates the Document —
the demo loader, or the User pasting into the create form — and `document.requestText` is a
Manual Connector.

## Identity and authorisation

**Nobody in this system checks a password except Keycloak** (D-022).

```mermaid
flowchart LR
    B["Browser"] -->|"redirect, OIDC"| KC["Keycloak :8089<br/>realm A12Realm"]
    B -->|"token"| FE["frontend :8081"]
    FE -->|"Bearer"| SRV["server :8082<br/>UAA, authentication.types=OAUTH2"]
    SRV -.->|"verify only — no login endpoint"| KC
    RT["runtime"] -->|"direct access grant<br/>assistants-runtime-client"| KC
    RT -->|"Bearer"| SRV
    B2["Browser"] -->|"OIDC"| FP["firefly-proxy :8084"]
    FP -.-> KC
    FP -->|"X-Forwarded-Email"| FF["firefly<br/>remote_user_guard"]
```

- The **web application has no login form.** Opening it redirects to Keycloak and comes back with
  a token. The ThingStore runs A12's UAA with `authentication.types=OAUTH2`, so it only verifies
  tokens and has no login endpoint of its own.
- The **Runtime has no browser to redirect**, so it uses Keycloak's direct access grant against
  `assistants-runtime-client` — the only client in the realm permitting it.
- **Firefly III has no OIDC support at all.** `remote_user_guard`, which trusts an HTTP header, is
  the whole of its support for an external identity provider. So `firefly-proxy` (oauth2-proxy)
  owns port 8084, runs the OIDC flow, and forwards the request with `X-Forwarded-Email` set.
  Firefly publishes **no port of its own**, because anything that could reach it directly could
  set that header itself. `FIREFLY_EMAIL` must stay equal to the `email` of the Keycloak user who
  browses the books, or the bootstrap container mints its token for one Firefly account and the
  human reads another.
- `KC_HOSTNAME` pins the issuer to `http://localhost:8089` so a token minted over the internal
  `keycloak:8080` address still validates. Without it, the proxy — which redeems its authorization
  code internally — would get tokens the ThingStore rejects.
- Realm import is **create-only**: editing `compose/keycloak/*` changes nothing until `just clean`
  drops the volume.

### Roles

Realm roles map to A12 access rights through `import/auth/roles.yaml` — the one part of
authorization that is ours rather than the platform's.

| Role | Access rights |
|---|---|
| `admin` | `ASSISTANT_WRITE`, `DOCUMENT_CREATE`, `DOCUMENT_UPDATE`, `DOCUMENT_PARTIAL_UPDATE`, `DOCUMENT_DELETE`, `ATTACHMENT_UPLOAD`, `MODEL_MANAGE`, `QUERY` |
| `user` | `ASSISTANT_WRITE`, `DOCUMENT_CREATE`, `DOCUMENT_UPDATE`, `DOCUMENT_PARTIAL_UPDATE`, `DOCUMENT_DELETE`, `MODEL_READ`, `ATTACHMENT_UPLOAD`, `QUERY` |
| `systemAdmin` | `ACCESS_ACTUATOR`, `MANAGE_CACHES`, `RELOAD_AUTH_RULES` |
| `runtime` | `DOCUMENT_CREATE`, `DOCUMENT_UPDATE`, `DOCUMENT_PARTIAL_UPDATE`, `MODEL_READ`, `QUERY` |

`ASSISTANT_WRITE` covers **`Assistant_DM` and `Operation_DM`** — the system's own definition, as
opposed to what the household owns. The right's name is narrower than its job, which is the accepted
cost of reusing it rather than minting an `OPERATION_WRITE`: a "may edit Assistants but not
Operations" role is one a single-household system has no use for (ADR-0019).

The **absent** rights on `runtime` are the point:

- no `DOCUMENT_DELETE` (D-007), so an Assistant that hallucinates a delete gets a `-32059` from
  the store instead of losing an invoice;
- no `MODEL_MANAGE`;
- no `ASSISTANT_WRITE` (D-007a), so an Assistant can neither grant itself an Operation nor edit the
  Operation it was granted — no unticking *requires approval* on the one that moves money, and no
  widening the sentence the model reads to decide when to call it. `ASSISTANT_WRITE` is **not an A12
  built-in** — it is ours, named in `roles.yaml` and enforced by the "System Definition Write
  Permission" in `import/auth/childAuthorizationDefinition.json`, which tests both Models in all
  three resource shapes the Data Service checks writes with. It is held by every human role and by
  no machine one.

Both refusals are enforced **by the store**, not inside the same LLM-driven process that would be
doing the escalating.

The Runtime logs in as a dedicated `runtime` user, never as `admin`, for a second reason too:
`__meta.creator` is the only provenance the ThingStore records, so an admin Runtime's writes would
be indistinguishable from the human's edits in the UI.

`just bootstrap` runs as the **User** (`BOOTSTRAP_USER`, default `human`), not as the Runtime,
because an Assistant is the User's to write — and so, now, is an Operation.

### Secrets

Every credential lives in one gitignored file, `.env` at the root (D-023). `just setup` writes it
from the committed `.env.example`, generating the machine credentials — the four database
passwords, Firefly's app key and cron token, oauth2-proxy's client and cookie secrets — so no two
clones share one. It refuses to overwrite an existing `.env`, because the database passwords are
baked into the Postgres volume the first time it starts.

The four *login* passwords are deliberately not generated: they are the development defaults the
README quotes, and they are safe only because of the `127.0.0.1` binding.

The Keycloak realm files would hold credentials, so they are generated too: `compose/keycloak/*.template`
is committed and `just render-secrets` renders the real ones from `.env` on every `just up`.
`.gitguardian.yaml` scopes the two files holding published login passwords — `.env.example` and
`e2e/fixtures/users.json` — out of secret scanning, and nothing else.

## System boundaries

**Exposed**: nothing. The system offers no public API. The A12 JSON-RPC interface on `:8082` is
consumed by the UserInterface and the Runtime, both inside the compose network, and published on
localhost for debugging.

**Consumed**:

| External system | Protocol | Reached by |
|---|---|---|
| Firefly III | REST + personal access token | Runtime, via the Firefly Connector |
| An LLM API | HTTPS (OpenAI-compatible or Anthropic Messages) | Runtime, via `LlmProvider` |
| Keycloak | OIDC / direct access grant | Frontend, ThingStore, Runtime, oauth2-proxy |

**Manual**: Email and Bank have no integration at all. They are Manual Connectors — they raise an
Open Question and the User does the work by hand. This is deliberate: ADR-0004 requires the system
to run end to end with every External System manual, and this is where that is proved.

## Infrastructure and operation

Everything is `docker compose`, driven by `just`. See [README.md](../../README.md) for the full
recipe table.

- `just setup` → `just dev` → `just demo-data` gets from a fresh clone to a populated system.
- `just dev` is `build` → `up` → `wait` → `bootstrap`, and is idempotent.
- **Exactly one Runtime replica** (ADR-0014). This is a constraint of the design, not a packaging
  detail: A12 has no compare-and-swap, so `leaseUntil` is crash *recovery*, not mutual exclusion,
  and two replicas would both claim an expired lease. Scaling out needs A12 to grow a
  compare-and-swap, or the Runtime to take a lock somewhere that has one.
- The Runtime's healthcheck reads **heartbeat freshness**, not process liveness — because silence
  is the one failure the User cannot otherwise detect.
- `just pause` / `just resume` toggle `RuntimeState.paused`, the global kill switch.
- `just logs runtime` is the debugging surface for the agentic loop. A Conversation's transcript
  is also stored on the Conversation Thing, though it renders as a data grid rather than a
  transcript view.

### Bootstrap versus demo data

Two loaders, deliberately distinct:

- **`just bootstrap`** loads what the system *is*: the Receptionist, the Accountant, the catalogue
  of Operations and the `RuntimeState` singleton. It **reconciles**, in three different ways,
  because the three have different owners. The Assistant seeds are re-applied on every run, so a
  prompt edited in the web application is overwritten. `RuntimeState` is left alone, because it is
  live state. An Operation gets both: the mechanical mirror of the code — `system`, `kind`,
  `parameters`, `mutating` — is re-applied, while the prose, `requiresApproval`, `enabled` and
  `notes` are created once and never touched again. The rule in one line is *re-apply what the code
  knows and never re-apply a decision*; a description improved in code therefore reaches only fresh
  installs, and bootstrap reports the divergence by name rather than leaving it to be discovered.
- **`just demo-data`** loads what the household *has*: parties, processes, documents, invoices and
  the matching Firefly accounts, budgets and transactions. It pauses the Runtime while loading, so
  the demo set lands as history rather than as a work queue, and advances the watermark past
  everything it created.
- **`just demo-reset`** is a full teardown and rebuild, because Firefly has no bulk delete and its
  books live in a named volume — a full teardown is the only reset symmetric across two
  Authorities.

## Testing

| Tier | Runner | Proves |
|---|---|---|
| **Model validation** | `import/validate-models.mjs` + Gradle `convertModels` | Every `_DM`/`_FM`/`_OM` is well-formed; **both directions** — an `elementRef` with no field fails, and a field no form model references warns, with an allow-list for the deliberately machine-owned ones. Also that every `indexed` field the watcher uses exists |
| **Runtime unit** | vitest | The loop driver against `ScriptedProvider`: birth, one Turn, dispatching a call, grant resolution and the four ways it can drop one, suspension on `askUser`, continuation on answer, `wakeAt` timeout, lease recovery **without re-execution**, one Invoice → exactly one Accountant Conversation, `maxTurns` → Open Question, late child result, self-call rejection |
| **Integration** | vitest against the live stack | The A12 client's CRUD and query, search-then-create idempotency, the Thing repository, every watcher query, the Firefly connector. Skipped rather than failed when the stack is down |
| **Client** | vitest | The markdown editor's suite and the client's own |
| **End-to-end** | Playwright, `LLM_PROVIDER=scripted` | Login as four users, every module opened, Party CRUD, a prompt round-tripped through the markdown editor, localisation, the favicon, the whole invoice slice, and surviving a restart |
| **Live LLM** (opt-in) | Playwright | The same specs against a real model. Skipped without `LLM_API_KEY` |

The scripted provider is not a mock of a collaborator we own — it is a *recorded* substitute for a
paid, non-deterministic third party, and it is the only way the loop's branching (pending tool
call → suspend → resume) can be asserted at all.

`just check` is the fast loop with no Docker: typecheck the Runtime; typecheck, lint and
format-check the client and `e2e`; validate the models; and verify the documentation claims
`scripts/check-docs.mjs` can check.

## Rejected alternatives

| Alternative | Why not |
|---|---|
| Temporal, or any workflow engine | Durable, restartable, days-long conversations come from an append-only transcript plus a re-entrant loop. Temporal adds a cluster and a second event history, which ADR-0006 forbids |
| The Runtime exposing a REST API the UI calls | A second authority for pending work, custom client code, and a live process holding state (D-005, ADR-0011) |
| A12 relationship models for Thing references | Binds a reference to a target Model at the model layer — the typed-identifier design ADR-0002 rejects |
| Skills as their own Things | Invites the sharing ADR-0009 forbids |
| A `consumedAt` stamp on the answered Open Question | A second Runtime write to a document the User may be editing. Consumption moved to the Conversation instead |
| A separate `Answer` Model | A12 navigation is scene-based with no way to open a create-form pre-filled from the row you came from; it would force the User to copy a ThingID by hand |
| The Runtime as A12 server code | Fuses the application's lifecycle to the platform's, and gives the LLM-driven half privileged access |
