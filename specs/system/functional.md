# Functional — what the system does

The User's view: what can be done, what goes in, what comes out, and where the edges are. The
concepts behind these features are in [domain.md](domain.md); how they are built is in
[architecture.md](architecture.md); how to run any of it is in [README.md](../../README.md).

There is exactly one human role in practice — the **User**, the household's supervisor — plus a
machine identity, the **Runtime**, and the test identities the end-to-end tier uses.

## Features

### Answering Open Questions

The User's actual inbox, and the feature the rest exists to serve.

An **Open Questions** module lists every question no one has answered — a plain overview over one
Model, filtered `undefined_match(answeredAt)`. That filter is ADR-0004's demand that "awaiting the
User must be a queryable state", satisfied literally, and it is also `OpenQuestionPending_QeM`.

Opening a row shows the question and an answer control decided by its **kind**:

| Kind | The User does | Filled in |
|---|---|---|
| `free-text` | Types an answer | `text` |
| `confirm` | Says yes or no | `confirmed` |
| `choice` | Picks one of a declared list | `choice` |
| `perform` | Does something by hand and reports back | `text` |

`perform` is what a **Manual Connector** raises when it needs the User to *do* something — send an
email, move money, paste in a document's text — and what a terminal failure raises to report an
error. It is not a special mechanism; it is the same Open Question with a different prompt.

An **approval** is not a kind either. When an Assistant calls an Operation that requires one —
`bookkeeping.postTransaction`, and nothing else today — the Runtime refuses the call and raises an
ordinary `confirm` question, opening *"**Approval needed.**"* and rendering the exact posting as a
sentence: *"Book €96.50 from Payables to Expenses:Health, dated 2026-08-01, for …?"* Saying yes is
the whole of the interaction; nothing is booked until you do (ADR-0018). Two things about it are
worth knowing:

- **The Assistant's own polite question does not count.** It will often ask first, because its prompt
  tells it to. That question authorises nothing, so a booking usually costs two answers — the
  Assistant's, and the Runtime's.
- **Answer it with the tick, not only with words.** Anything short of an explicit yes is read as a no,
  and a no is final for that exact posting.

Saving the form is the whole of the interaction. There is no button that calls the Runtime and
nothing in the web application that knows the Runtime exists — the Runtime notices the answer on
its next scan, within about two seconds.

### Browsing and editing Things

Nine navigation modules, one per Model: **Open Questions**, **Documents**, **Invoices**,
**Processes**, **Parties**, **Assistants**, **Operations**, **Conversations**, **Runtime**. Each is
an ordinary A12 master-detail: an overview of scalars, and a form for one row.

Four are freely editable by the User — `Party`, `Document`, `Invoice`, `Process`. Creating an
`Invoice` or a `Document` by hand is a supported way in; so is pasting extracted text into a
Document's `extractedText`.

### Editing an Assistant

**Assistants are Things you edit in the UI, not code you deploy** (ADR-0003). Changing the
Receptionist's behaviour is editing a document: its `systemPrompt`, its `skills[]` (each a name
and a markdown body), its `llmModel`, its `maxTurns`, its `enabled` flag, its `triggers[]` and its
`grants[]` — one row per Operation it may use, under **Granted operations**, and one row per callee
for `assistant.call:<key>`.

Prompts and Skill bodies are **markdown fields**, rendered by the lifted Lexical editor — headings,
lists, tables, code blocks, admonitions, a table of contents. Round-tripping markdown through that
editor is covered by the end-to-end tier.

Only the User may write an `Assistant`. The Runtime holds no `ASSISTANT_WRITE` right, so an
Assistant cannot grant itself an Operation; the store refuses it (D-007a).

Note that `just bootstrap` **reconciles**: it re-applies the two seeded Assistant definitions on
every run, so a prompt edited in the web application is overwritten the next time it runs. To keep
an edit, change the seed in `runtime/src/bootstrap/assistants.ts`.

### Reading and editing the catalogue of Operations

The **Operations** module is the answer to *"what can my Assistants actually do?"* — a question that
used to require reading TypeScript. It lists every Operation the Runtime knows how to perform, one
row each: its key, the System it belongs to, its kind, whether it is switched on, whether it needs
your approval, and whether it changes anything out there.

Opening one shows the whole of it, and which half of it is yours is the interesting part of the
form. The fields that are facts about the code are rendered read-only; the fields that are decisions
are not:

| Field | Whose | What it is for |
|---|---|---|
| `Key`, `System`, `Kind`, `Parameters` | the code's, read-only | What the Operation is and what arguments it takes. `Key` is what a grant names and what the Implementation is found by, so renaming it would point every grant at nothing |
| `Mutating` | the code's, read-only | Whether performing it changes something outside this system. It sits beside the approval checkbox because it is the input to the question that checkbox answers |
| `Name`, `Description` | **yours** | The label, and the prose the model reads, in markdown. The description is how a model decides which Operation to call, so it is prompt engineering, and it is now something you can edit without a deploy |
| `Enabled` | **yours** | Whether the Operation is offered at all |
| `Requires approval` | **yours** | Whether the Runtime refuses the call until it has asked you about those exact arguments and been told yes |
| `Notes` | **yours** | Why you did what you did |

Two of those deserve their own sentence.

**Switching an Operation off is the kill switch that was missing.** `just pause` stops everything
and an Assistant's `enabled` flag stops one Assistant; between them there was nothing. Unticking
`Enabled` on `bank.sendMoney` withdraws it from every Assistant that was granted it, takes effect on
the next Turn of every Conversation, survives a restart, and needs no deploy. An Assistant that then
tries to call it is told it is *switched off* — not that it never had it, which its own definition
would visibly contradict.

**`Requires approval` is yours in both directions.** You may add one where the code asks for none,
and remove one it does ask for — including on `bookkeeping.postTransaction`. The Runtime writes a
line in the log naming any Operation whose requirement you have weakened, once per restart, and
obeys you. That is deliberate: it is your money. It is also the one route an Assistant has to this
setting, since it cannot edit the catalogue but can compose a persuasive sentence asking you to.

What you cannot do is invent an Operation. The catalogue describes Operations; the code performs
them, and the two are joined by the key. An Operation with no Implementation registered under its
key is not offered to anybody and says so (ADR-0019).

Editing the catalogue never gives birth to a Conversation, and `just bootstrap` will not undo what
you decided: it re-applies only the fields the code owns — `System`, `Kind`, `Parameters`,
`Mutating` — and leaves the description, the approval requirement, the kill switch and your notes
exactly as you left them. The cost of that is the mirror image of the Assistant seeds: a description
improved in the source does *not* reach a system that already has the Operation, and bootstrap
reports it by name rather than letting you wonder.

### Giving an Assistant a schedule

An Assistant's `triggers[]` may carry a `schedule` row with a `cron` expression, read in
`SCHEDULE_TIMEZONE` (default `Europe/Berlin`). The seeded **Accountant** has one — `0 7 * * *` — so
it looks at what is outstanding each morning without anybody asking it to.

What to expect from one, because none of it is obvious:

- **It fires immediately.** A cron has no start date, so a schedule added this afternoon finds this
  morning's slot already past and runs on the next scan.
- **A missed run is caught up once.** Three days of downtime produce one Conversation, about today.
  A Schedule is a standing instruction about the current state of the world, not a backlog.
- **A run that finds nothing is silent**, and that silent Conversation is the record that the slot
  was served. `scheduledFor` is a column on the Conversations overview, so *"did Monday's run
  happen?"* is one search.
- **An unanswered question stops the schedule** until it is answered. That is why a scheduled Skill
  must gather everything and ask **once**.

### Watching an Assistant work

- The **Conversations** module shows every run: which Assistant, what it is about — or which
  `scheduledFor` instant it was born to serve — its status, what it is waiting for, its turn count,
  and its `entries[]`: the full transcript, as a read-only inline repeat. It is readable, but it is a
  data grid, not a transcript view.
- Each Entry carries what the Turn that wrote it cost, as prompt and completion tokens, on the first
  Entry that Turn wrote. Nothing adds them up — the transcript is the record, and a Turn that errored
  records nothing, so the total is a lower bound.
- `just logs runtime` is the better debugging surface.
- The **Runtime** module shows the singleton: the watermark, the pause flag, the births-per-hour
  counter, the heartbeat and the last error.

### Stopping it

- `just pause` sets `RuntimeState.paused` and the watcher does nothing at all until `just resume`.
- Setting an Assistant's `enabled` to `false` stops its births **and** its continuations.
- A births-per-hour cap bounds a runaway even if nobody is watching.

### The books

Firefly III at `http://localhost:8084`, behind oauth2-proxy, through the same Keycloak login. The
User works in it directly — it is the Authority, and nothing in this system holds a second copy of
what it says.

An Invoice's booking is found by searching Firefly for the tag `thing:<thingId>` or the
`external_id`; there is no field on the Invoice to read.

## User journeys

### An invoice arrives and gets booked

The vertical slice that runs today.

```mermaid
sequenceDiagram
    actor U as User
    participant UI as UserInterface
    participant TS as ThingStore
    participant RT as Runtime
    participant R as Receptionist
    participant A as Accountant
    participant BK as Bookkeeping

    U->>UI: creates a Document (or the demo loader does)
    UI->>TS: Document saved with extractedText
    RT->>TS: scan 1 — a Thing past the watermark
    RT->>R: birth a Conversation
    R->>R: classify: this is an invoice
    R->>TS: create the Invoice, link Document and Process
    R->>A: assistant.call:accountant
    Note over R: the Receptionist suspends, waitingFor = assistant
    A->>BK: listAccounts, getBudgetReport
    A->>TS: ui.askUser (confirm) — "book €96.50 to Expenses:Health?"
    Note over A,TS: waiting. Nothing runs. Days may pass.<br/>Restarts change nothing.
    U->>UI: opens Open Questions, confirms
    UI->>TS: answeredAt + confirmed saved
    RT->>TS: scan 2 — answered
    RT->>A: continue the same Conversation
    A->>RT: postTransaction
    Note over RT: the Assistant's own question authorises nothing.<br/>Refused before Firefly is reached (ADR-0018).
    RT->>TS: raise the approval question — "Book €96.50 from …?"
    U->>UI: confirms the exact posting
    RT->>A: scan 2 — continue again
    A->>BK: postTransaction, keyed and tagged thing:<id>
    A->>TS: append a step to the Process; finish
    RT->>R: scan 5 — deliver the result to the parent
    U->>BK: sees the transaction in the books
```

What the User actually does in this journey is three things: put a Document in, and answer two
questions — the Assistant's, and the Runtime's. Everything between is unattended. The second answer
is the one that books: the first is the Assistant being polite, and being polite authorises nothing.

### Surviving a restart mid-question

The claim ADR-0004 makes, and a test in the end-to-end tier:

1. Let the slice run until an Open Question is pending.
2. `just restart` — the Runtime and the store both go down and come back.
3. The Open Question is exactly where it was. Answering it continues the same Conversation.

Nothing was running to lose. The question *is* the state.

### A Manual Connector asks for help

An Assistant calls `email.send`, `bank.sendMoney` or `document.requestText`. None of them talks to
anything. Each raises an Open Question of kind `perform` — *"send this email and tell me when you
have"* — and the Conversation suspends exactly as it would on any other question. The User does
the work by hand, reports back in the answer, and the Conversation continues.

The Assistant cannot tell that a human rather than a machine answered, which is what makes
automating one later a Connector-only change.

### Something goes wrong

The User never has to check a second place. A terminal failure — retries exhausted, `maxTurns`
reached, an Authority refusing again and again — does not set `failed`. It raises an Open Question
carrying the error and waits, so a stuck Conversation appears in the same list as everything else.
Escalation is capped at three per Conversation, so a persistent outage answered with "try again"
cannot produce one question per attempt; the fourth time, the Conversation does end.

The failure this does *not* cover is the Runtime being unable to write the question at all. That
is what the heartbeat is for: the service reports itself unhealthy once its last successful scan
is stale, and `just ps` shows it.

## Inputs and outputs

### In

| Input | How | Notes |
|---|---|---|
| A **Document** | Created in the web application, or by the demo loader | `extractedText` must be supplied — nothing extracts it |
| An attachment | Uploaded on the Document form | Stored in the A12 Content Store |
| An **answer** | Saving an Open Question form | The only interaction the whole slice requires |
| An **Assistant definition** | Editing the Assistant form, or the seed file | Markdown prompts and Skills |
| **Demo data** | `just demo-data` | Parties, processes, documents, invoices, and matching Firefly books |
| **LLM configuration** | `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_BASE_URL` | `scripted` by default; costs nothing and needs no key |
| A **schedule** | A `cron` on an Assistant's `schedule` Trigger | Read in `SCHEDULE_TIMEZONE`, default `Europe/Berlin`. One timezone for the whole system |

### Out

| Output | Where |
|---|---|
| **Open Questions** | The web application's inbox |
| **Things** — Invoices, Parties, Process steps | The ThingStore, visible in the UI |
| **Transactions** | Firefly III, tagged `thing:<thingId>` with a deep link in `external_url` |
| **Transcripts** | `Conversation.entries[]`, and `just logs runtime` |
| **Health** | The Runtime's compose healthcheck, driven by `heartbeatAt` |

Nothing is emailed, nothing is paid, and nothing leaves the machine except calls to the configured
LLM API.

## States and transitions

### Conversation

```mermaid
stateDiagram-v2
    [*] --> running: Trigger — a Thing materialised,<br/>assistant.call, or a schedule slot fell due
    running --> running: a Turn completes,<br/>the model wants more tools
    running --> waiting: an Operation returns pending
    waiting --> running: the answer arrives,<br/>wakeAt passes,<br/>or a child result is delivered
    running --> waiting: terminal failure —<br/>an Open Question carries the error
    running --> done: finishReason = answered
    waiting --> failed: the User abandons it,<br/>or a fourth escalation
    done --> [*]
    failed --> [*]
```

`waitingFor` says which: `user`, `tool` or `assistant`. There is deliberately no `llm` value —
waiting on the LLM happens *inside* a live Turn and is over in seconds; if the process dies there,
the Conversation is simply un-advanced and the next scan picks it up. **Only waits that outlive a
Turn are written down.**

`failed` means only "the User abandoned it" — a state a human chose, never one the system fell
into.

A Conversation being advanced carries `leaseUntil`. That is crash **recovery**, not a lock: a
lease found expired means the Runtime died mid-Turn, and scan 4 recovers per the intent log —
asking the Connector whether the key landed, never re-executing blind.

### Document → Invoice

```mermaid
stateDiagram-v2
    [*] --> arrived: a Document materialises
    arrived --> classified: the Receptionist decides what it is
    classified --> linked: an Invoice is created,<br/>classifiedThingId points at it
    note right of linked
        The Document keeps its ThingID for ever.
        Classification creates and links;
        it never rewrites the Document.
    end note
```

### Open Question

```mermaid
stateDiagram-v2
    [*] --> pending: the Runtime writes it<br/>at the moment it suspends
    pending --> answered: the User saves the form
    answered --> consumed: the Conversation advances
    note right of consumed
        Consumption is recorded on the Conversation,
        not on the question — the Runtime never
        writes this document twice.
        A late edit therefore changes nothing.
    end note
```

### Process

A Process is the routing slip: a title, a `kind`, a `status` and an append-only list of `steps[]`,
each with its own state. It is **passive** — nothing executes it. Assistants append steps to
record what happened; the Process never drives anything.

## Permissions and visibility

There is one human role in practice, and the interesting boundaries are not between humans but
between the human and the machine.

| | User (`admin` / `user` roles) | Runtime (`runtime` role) |
|---|---|---|
| Read every Thing | ✓ | ✓ |
| Create / update `Party`, `Document`, `Invoice`, `Process` | ✓ | ✓ |
| Write `Assistant` | ✓ | ✗ — no `ASSISTANT_WRITE` (D-007a) |
| Write `Operation` | ✓ | ✗ — the same right and the same refusal (ADR-0019) |
| Write `Conversation`, `RuntimeState` | form is read-only | ✓ |
| Write `OpenQuestion` | the answer fields | once, at creation |
| Delete anything | ✓ | ✗ — no `DOCUMENT_DELETE` (D-007) |
| Manage models | `admin` only | ✗ |

Read-only forms are an **affordance, not an authorisation boundary**. What protects the
single-writer invariant is that nothing in the UI navigates to those documents in edit mode, not
that the server would refuse.

Between Assistants, capability is declared rather than assumed: an Assistant may call only the
Operations its `tools[]` lists, one row per Operation, and one row per callee for
`assistant.call:<key>`. The registry filters the schemas offered to the model, so an undeclared
Operation is **invisible**, not merely refused. Self-calls are rejected. Reading an Assistant tells
you exactly what it can reach (ADR-0010).

Everything is on `127.0.0.1`. There is no multi-tenancy, no sharing and no per-Thing visibility.

## Edge cases and known limitations

This is one running vertical slice, not a finished system.

**Deliberate omissions**

- **Email and Bank are Manual Connectors.** `email.send`, `email.fetch` and `bank.sendMoney` talk
  to nothing. This is the point — ADR-0004 requires the system to run end to end with every
  External System manual — but it means no mail is fetched and no money moves.
- **Text extraction is not implemented.** `extractedText` is supplied by whoever creates the
  Document. `document.requestText` is a Manual Connector. OCR and PDF parsing are a later change.
- **`bookkeeping.createAccount` is granted to no Assistant.** The chart of accounts is a
  structural decision the User makes.
- **No compaction, forking or steering** of Conversations. `maxTurns` (default 20) is the only
  bound on a long one, and reaching it raises an Open Question.
- **The transcript renders as a data grid**, not a transcript view. A proper viewer would be
  custom client code, which D-005 exists to avoid.
- **No cross-document links inside markdown.** The lifted editor has none, and inventing a link
  syntax is its own change.

**Gaps**

- **Parties have no proper Authority.** The ThingStore holds them provisionally, pending an
  address book Connector (ADR-0013).
- **A schedule stalls on an unanswered question.** A slot is skipped entirely while the previous one
  is unfinished (ADR-0016), so one question nobody answers holds every later firing. That is
  deliberate — two live Conversations for one recurring errand would be two questions the User cannot
  tell apart — and it is a log warning rather than a second question about the first. The fix is to
  answer it.
- **Nothing aggregates what a Conversation cost.** A Turn carries what the model charged for it and
  the transcript is where you read it. No dashboard, no billing, no second store — and the sum is a
  lower bound, because a Turn that errored records nothing.
- **An answered question does not leave the pending view.** `OpenQuestionPending_QeM` filters on
  `answeredAt` being unset, and nothing stamps that field — while the Runtime's `isAnswered` counts
  *any* filled answer field, so the Conversation does continue. The row simply stays in the inbox
  looking unanswered. Pre-existing, and approvals make it twice as visible, because a booking now
  raises two questions rather than one. The fix is to widen the query model's constraint to all four
  answer fields, which wants `undefined_match` on a Boolean verified against the live store first.
- **`updatedAt` records the last Runtime write only.** A save from the web application moves only
  `__meta.modifiedAt`, because the machine fields are on no form and A12's form engine offers no
  save hook that could reach one.

**Operational limits**

- **Exactly one Runtime replica.** Not a deployment convenience — A12 has no compare-and-swap, so
  two replicas would both claim an expired lease and silently lose one writer's work.
- **Latency is one scan interval**, about two seconds.
- **`just bootstrap` overwrites Assistant edits.** It reconciles by design.
- **`just clean` and `just demo-reset` take the books with them.** Firefly has no bulk delete and
  its data lives in a named volume, so a full teardown is the only reset symmetric across two
  Authorities.
- **The end-to-end suite writes to whatever stack it is pointed at**, creating and deleting Things.
  Point it at a development stack only. `cd e2e && npx playwright test --list` is the authority on
  what it runs.

**Security posture**

- **Authentication is real; its configuration is development-grade.** The mechanism is the one A12
  intends — Keycloak, OIDC, no password checked anywhere else — and no credential is committed
  (D-023). But Keycloak runs `start-dev` over plain HTTP, its console is `admin` / `admin`, and the
  realm's password policy is relaxed far enough to allow `human` / `human`. Every one of those is
  deliberate for a stack bound to `127.0.0.1`. Do not expose it further without replacing all of
  them.
- **Firefly III trusts a header.** `remote_user_guard` performs no validation of
  `X-Forwarded-Email` whatsoever. Inside the compose network Firefly is wide open, which is what
  lets the Runtime and `firefly-bootstrap` use it; the entire security argument is that it
  publishes no host port. Give it one and authentication is gone.
