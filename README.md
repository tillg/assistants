<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo/lockup-dark.svg">
    <img src="assets/logo/lockup-light.svg" alt="Assistants" width="300">
  </picture>
</p>

# Assistants

Assistants is a personal system of LLM-driven **Assistants** that do real administrative work
for one household — invoices, insurance claims, a house renovation — under the **User's**
supervision. An Assistant is not a chat window. It wakes on a **Trigger**, does a piece of work
against **Things** in the **ThingStore**, asks the User when it needs a decision, and stops. The
question it asked is the whole of its state, so nothing is running while it waits, and a restart
in the middle changes nothing.

What runs today is one vertical slice, end to end. A doctor's invoice arrives as a **Document**.
The **Receptionist** classifies it, extracts the fields and creates an **Invoice** Thing, then
calls the **Accountant**. The Accountant reads the chart of accounts out of **Bookkeeping**,
proposes a posting, and raises an **Open Question**: *book €96.50 to Expenses:Health?* The
**Conversation** stops there. The User answers it in the web application — hours or days later,
across as many restarts as you like — and only then does the transaction land in the real books.
Nothing is booked without an answer.

The system is built on [A12](docs/adr/0001-a12-as-the-platform.md): Things are A12 documents
governed by A12 models, the ThingStore is an A12 Data Service, and the **UserInterface** is an A12
web application. The vocabulary the code, the models and the documents all share is fixed in
[CONTEXT.md](CONTEXT.md); read that first if a word here looks like it might mean something loose.
Spelling throughout the project is British English.

**Companion documents**: [CONTEXT.md](CONTEXT.md) (the glossary) ·
[DECISIONS.md](DECISIONS.md) (decisions taken while building, with their alternatives and
reversal costs) · [BUGS.md](BUGS.md) (43 reproduced defects from the 2026-08-09 hunt; each entry
records whether it still stands) ·
[docs/adr/](docs/adr/) (fifteen architecture decisions) ·
[ACCOUNTING.md](ACCOUNTING.md) (what Bookkeeping must provide, and why Firefly III) ·
[AGENTIC_LOOP.md](AGENTIC_LOOP.md) (the loop's open questions, and a survey of how three existing
agent systems answer them) · [MARKDOWN_FIELDS.md](MARKDOWN_FIELDS.md) (what is still undecided
about markdown fields) · and the change that built this,
[specs/changes/first-running-system/](specs/changes/first-running-system/).

## How it works

Everything runs in one `docker compose` file: seven long-running services and two one-shot init
containers. No second database engine, no message broker, no workflow engine.

```mermaid
flowchart LR
    subgraph compose["docker compose"]
        direction TB
        PG[("postgres<br/>:8083")]
        KC["keycloak<br/>= identity provider<br/>:8089"]
        SRV["server — A12 Data Service<br/>= ThingStore<br/>:8082"]
        INIT["server-init<br/>schema + model import"]
        FE["frontend — A12 web app<br/>= UserInterface<br/>:8081"]
        RT["runtime<br/>trigger watcher + loop driver"]
        FP["firefly-proxy — oauth2-proxy<br/>:8084"]
        FF["firefly — Firefly III<br/>= Bookkeeping<br/>(no published port)"]
        FB["firefly-bootstrap<br/>one-shot: token"]
    end
    LLM["LLM API<br/>(scripted by default)"]

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

One Postgres container, four databases: `assistants-ds` (the Things), `assistants-cs` (binary
content), `assistants-firefly` (the books) and `assistants-keycloak` (the users). The first two are
A12's own split — each carries its own Liquibase changelog — and Firefly and Keycloak own one
outright each ([D-004](DECISIONS.md)).

The dotted edges are the whole of authentication. **Nobody in this system checks a password
except Keycloak** ([D-022](DECISIONS.md)):

- the **web application** has no login form. Opening it redirects to Keycloak and comes back with
  a token; the ThingStore runs A12's UAA with `authentication.types=OAUTH2`, which means it only
  verifies tokens and has no login endpoint of its own. Realm roles in the token map to A12 access
  rights through `import/auth/roles.yaml` — the one part of authorization that is still ours.
- the **Runtime** has no browser to redirect, so it uses Keycloak's direct access grant against a
  client that is the only one in the realm permitting it.
- **Firefly III has no OIDC support at all** — `remote_user_guard`, which trusts an HTTP header, is
  the whole of its support for an external identity provider. So `firefly-proxy` (oauth2-proxy)
  owns port 8084, runs the OIDC flow, and forwards the request with `X-Forwarded-Email` set.
  Firefly publishes no port of its own, because anything that could reach it directly could set
  that header itself.

The Runtime is a client of the ThingStore with no privileged access, exactly like the
UserInterface. It polls; it exposes no API and receives no webhooks. That is the whole
integration surface ([D-005](DECISIONS.md)).

The doctor's-invoice slice, as it actually executes:

```mermaid
sequenceDiagram
    actor U as User
    participant UI as UserInterface<br/>(A12 web app)
    participant TS as ThingStore<br/>(A12 Data Service)
    participant RT as Runtime
    participant R as Receptionist
    participant A as Accountant
    participant BK as Bookkeeping<br/>(Firefly III)

    U->>TS: a Document materialises (invoice text + attachment)
    RT->>TS: scan → new Thing past the watermark
    RT->>R: Trigger: birth a Conversation
    R->>R: classify, extract the fields
    R->>TS: create the Invoice, link it to the Process
    R->>A: assistant.call (asynchronous, ADR-0007)
    A->>BK: read the chart of accounts, check open items
    A->>TS: ui.askUser → an Open Question
    Note over A,TS: The Conversation stops.<br/>Nothing is running.
    U->>UI: sees the Open Question and answers it
    UI->>TS: the answer is saved on the Open Question
    RT->>TS: scan → answered
    RT->>A: continue the same Conversation
    A->>BK: postTransaction (keyed, idempotent)
    A->>TS: append a step to the Process
```

## Quick start

### Prerequisites

| Tool | Version | Pinned by |
|---|---|---|
| Docker | ≥ 20 | — |
| Docker Compose | ≥ 2.20.3 | needed for `service_completed_successfully` |
| JDK | ≥ 21, ≤ 25 | `.sdkmanrc` (21.0.6-tem) |
| Gradle | ≥ 9 | `.sdkmanrc` (9.5.0) |
| Node | 24.x | `.nvmrc` |
| npm | ≥ 11 | ships with Node 24 |
| [`just`](https://just.systems) | any recent | — |

`.nvmrc` and `.sdkmanrc` pin the exact versions this repository was built against; `nvm use` and
`sdk env` will pick them up. The A12 artefacts resolve from the **public** community registries
pinned in `.npmrc` and `settings.gradle`, so no VPN and no credentials are needed
([D-006](DECISIONS.md)).

### Run it

```
just setup
just dev
just demo-data
```

`just setup` writes `.env` from the committed `.env.example` and generates every machine
credential in it. Run it once per clone; it refuses to overwrite an existing `.env`, because the
database passwords are baked into the Postgres volume the first time it starts
([D-023](DECISIONS.md)).

`just dev` builds the models, the server jars, the client bundle and every image, brings the
stack up, waits until the ThingStore, Firefly, Keycloak and the frontend all answer, and loads the
two Assistants and the Runtime state. It is idempotent — run it again after any change. `just demo-data` then loads a household:
parties, a renovation Process, documents and invoices in several states, and matching Firefly
accounts, budgets and transactions. It pauses the Runtime while loading, so the demo set lands as
history rather than as a work queue.

Then:

- **<http://localhost:8081>** — the A12 web application. It redirects to Keycloak; log in as
  `human` / `human`. The navigation has one entry per Thing: Open Questions, Documents, Invoices,
  Processes, Parties, Assistants, Conversations, Runtime. Start at **Open Questions** — that is the
  User's actual inbox. **Assistants** is where you read and edit a prompt, in the markdown editor.
- **<http://localhost:8084>** — Firefly III, the books, behind oauth2-proxy. The same
  `human` / `human` through the same Keycloak, and if you are already signed in at 8081 it lets you
  straight through. `just firefly-token` prints the personal access token the bootstrap container
  minted, if you want to talk to its API yourself — `/api/` bypasses the proxy, because Firefly
  checks that token on a guard of its own.
- **<http://localhost:8089>** — the Keycloak admin console, `admin` / `admin`. Realm `A12Realm`
  holds every user: `human`, the service account `runtime`, and `admin` / `user1` / `user2`, which
  the end-to-end tier uses.
- **<http://localhost:8082>** — the ThingStore's A12 JSON-RPC and REST interface;
  `/actuator/health` is the liveness endpoint `just wait` polls.

To watch an Assistant work, `just logs runtime`. A Conversation's transcript is also stored on the
Conversation Thing and visible in the UI, though as a data grid rather than a transcript view.

### The language model

The stack runs with a **scripted** language model by default: `LLM_PROVIDER=scripted` replays
`runtime/fixtures/llm-script.json`, which scripts the full doctor's-invoice scenario across both
Assistants. It costs nothing, needs no key, and behaves the same every time — which is what lets
the end-to-end tier drive the *real* Runtime, ThingStore, Firefly and UI deterministically.

To point it at a real model, set the environment before `just up` (or `just dev`):

```
export LLM_PROVIDER=openai
export LLM_API_KEY=sk-...
export LLM_MODEL=gpt-4o-mini          # optional; this is the default
export LLM_BASE_URL=https://api.openai.com/v1   # optional; any OpenAI-compatible endpoint
```

`LLM_PROVIDER=anthropic` selects the Anthropic Messages API implementation instead. The choice is
a compose-level environment variable rather than a constructor argument, on purpose
([D-002](DECISIONS.md)).

## Commands

`just` is the single entry point. `just` on its own lists everything.

### The stack

| Recipe | What it does | When you want it |
|---|---|---|
| `just` | Lists every recipe, unsorted | To remember what exists |
| `just setup` | Writes `.env` from `.env.example`, generating every machine credential, then renders the Keycloak files. Refuses to overwrite an existing `.env` | Once, on a fresh clone, before anything else |
| `just dev` | `build` → `up` → `wait` → `bootstrap`, then prints the URLs. Idempotent | The one command to get from a set-up clone to a running system |
| `just build` | Converts the models, builds the server jars and images, builds the runtime image | After changing a model, the client, the server or the Runtime |
| `just up` | Renders the Keycloak secrets, then starts the stack in the background, including the `server-init` profile | When the images are already built |
| `just render-secrets` | Regenerates `compose/keycloak/*` from the templates and `.env` | Called by `setup` and `up`. On its own after editing a password in `.env` |
| `just wait` | Polls the ThingStore, Firefly, Keycloak and the frontend for up to four minutes | Called by `dev`; useful on its own in scripts |
| `just down` | Stops the stack and keeps the data | End of the day |
| `just restart [service]` | Restarts one service, or all of them | The ADR-0004 restart test: suspend on a question, restart, confirm it survived |
| `just ps` | Shows what is running | First thing to check when something is wrong |
| `just logs [service]` | Follows the logs, last 200 lines | `just logs runtime` is the debugging surface for the agentic loop |

### Data

| Recipe | What it does | When you want it |
|---|---|---|
| `just bootstrap` | Loads what the system **is**: the Receptionist, the Accountant and the `RuntimeState` singleton. Idempotent, and it *reconciles* — the Assistant seeds are re-applied on every run, so a prompt edited in the web application is overwritten. The `RuntimeState` is left alone, because it is live state | Called by `dev`. Re-run after editing the seeded Assistant definitions |
| `just demo-data` | Loads what the household **has**: parties, processes, documents, invoices, and the Firefly books. Pauses the Runtime while loading | A realistic system to look at, without spending anything |
| `just demo-reset` | `clean` → `build` → `up` → `wait` → `bootstrap` → `demo-data`. Takes the books with it | When the demo state has drifted. Firefly has no bulk delete and its data lives in a named volume, so a full teardown is the only reset symmetric across both Authorities |
| `just firefly-token` | Prints the Firefly personal access token from the shared volume | Talking to the Firefly API by hand |
| `just pause` | Sets `RuntimeState.paused` — the global kill switch | An Assistant is doing something you did not expect |
| `just resume` | Clears it | After you have looked |

### Tests

| Recipe | What it does | When you want it |
|---|---|---|
| `just test` | `test-models` + `test-runtime` + `test-integration` + `test-client` + `test-e2e`, in that order | Before claiming anything is done. The last three need the stack up |
| `just test-models` | `import/validate-models.mjs` in both directions, then the Gradle model conversion | After touching any model under `import/models/` |
| `just test-runtime` | The loop driver's branching under vitest: one Turn, tool gating, suspension, continuation, lease recovery, the runaway guards, Assistant-to-Assistant calls | After touching `runtime/src/` |
| `just test-integration` | The A12 client, the Thing repository, the watcher's queries and the Firefly connector against the **live** stack, one file at a time. Skipped rather than failed when the stack is down | After touching `runtime/src/a12/`, the watcher's queries or the Firefly connector — the tier that catches what the unit fakes cannot see. Requires the stack to be up |
| `just test-client` | The markdown editor's unit tests and the client's own | After touching `client/src/` |
| `just test-e2e` | Playwright against the running stack with the scripted model | Before a commit that touches the UI. Requires the stack to be up |
| `just test-live` | The same end-to-end specs against a live LLM. Skipped without `LLM_API_KEY` | Rarely, and deliberately — it costs money and is non-deterministic |

### Housekeeping

| Recipe | What it does | When you want it |
|---|---|---|
| `just check` | Typechecks the Runtime; typechecks, lints and format-checks the client and `e2e`; validates the models and the documentation claims `scripts/check-docs.mjs` can verify | The fast feedback loop; no Docker needed. Needs `just install` once, for `e2e/node_modules` |
| `just clean` | Removes containers, volumes and every build output. **Takes the books with it** | When the state is wrong rather than the code |
| `just clean-all` | `clean`, plus every `node_modules` | When a dependency tree has gone wrong |
| `just install` | `npm install` in `runtime`, `client` and `e2e` | Usually unnecessary — the builds do it |

## The parts

| Service | Host port | Is |
|---|---|---|
| `frontend` | 8081 | UserInterface — the A12 web application |
| `server` | 8082 | ThingStore — the A12 Data Service |
| `postgres` | 8083 | The stack's database (data service + content store + the books + the users) |
| `firefly-proxy` | 8084 | oauth2-proxy — the only way into Firefly from outside |
| `keycloak` | 8089 | The identity provider; realm `A12Realm`, console `admin` / `admin` |
| `firefly` | — | Bookkeeping — Firefly III 6.6.6 on Postgres. No published port, on purpose |
| `runtime` | — | The Runtime; no port, it only makes outbound calls |
| `server-init`, `firefly-bootstrap` | — | One-shot init containers |

Every host port is published on `127.0.0.1` only, and every credential in the stack lives in one
gitignored file, `.env` at the root ([D-023](DECISIONS.md)). `just setup` writes it from the
committed `.env.example`, generating the machine credentials — the four database passwords,
Firefly's app key and cron token, and oauth2-proxy's client and cookie secrets — so no two clones
share one. The four login passwords are *not* generated: they are the development defaults this
README quotes, and they are safe only because of that `127.0.0.1`.

Nothing else holds a credential. The files Keycloak imports would, so they are generated too:
`compose/keycloak/*.template` is committed and `just render-secrets` renders the real ones from
`.env` on every `just up`.

**ThingStore** (`server/`, `import/models/`) — an A12 Data Service holding every Thing and
exposing A12's JSON-RPC interface. It is the only integration surface in the system: the
UserInterface reads it, the Runtime polls it, and nothing else talks to anything directly. Eight
Models, each with a document model, a form model and an overview model, plus one application model
for navigation.

**UserInterface** (`client/`) — the A12 web application, generated from those models, with one
addition: the **markdown editor lifted from `w12-on-a12`** (`client/src/components/markdown-editor/`,
Lexical-based, with the collaborative-editing subsystem dropped). A field becomes a markdown field
by three coordinated facts — `lineBreaksPermitted` on the `StringType`, `"exposition": "AREA"` in
the form model, and a `widget: markdown-editor` annotation on the Control — which is what makes an
Assistant's prompts editable in the ordinary UI, as [ADR-0003](docs/adr/0003-assistants-are-things.md)
requires. See [MARKDOWN_FIELDS.md](MARKDOWN_FIELDS.md).

**Runtime** (`runtime/`) — TypeScript on Node 24, in two halves. The **Trigger Watcher** scans the
ThingStore every two seconds, in six passes: things that materialised, questions that were
answered, `wakeAt` deadlines that passed, leases that expired, child results not yet delivered, and
Conversations with a Turn owing. The **Loop Driver** is one function, `advance(conversationId)`,
that takes one Conversation exactly one Turn forward and returns holding nothing. Sixteen Tools are
registered — ThingStore reads and writes, `ui.askUser`, `assistant.call`, six `bookkeeping.*`
operations against Firefly, and four Manual Connector operations. It authenticates as a dedicated
`runtime` user with no `DOCUMENT_DELETE` and no `MODEL_MANAGE` ([D-007](DECISIONS.md)) — a Keycloak
user like any other, reached through the direct access grant because a headless process has no
browser to redirect; its health check is "did the last scan finish", not "is the process alive",
because silence is the one failure the User cannot otherwise detect.

**Bookkeeping** (`compose/firefly/`) — Firefly III on the stack's Postgres, in its own database
(`assistants-firefly`) under its own role, created by `compose/postgres/db-init.sh` alongside the
ThingStore's two databases. In the same compose file, brought up
with zero manual steps: a one-shot container mints a personal access token into a volume the
Runtime reads ([D-004](DECISIONS.md)). The connector never passes account
*names* to Firefly, because Firefly silently creates an account it does not recognise; it resolves
names to IDs and returns an error the model can correct itself against.

Its identity comes from Keycloak, but not by Firefly's own doing ([D-022](DECISIONS.md)): Firefly
III has no OIDC client, only `remote_user_guard`, which takes the user from an HTTP header and
validates nothing. So `firefly-proxy` authenticates the browser against Keycloak and sets
`X-Forwarded-Email`, and `FIREFLY_EMAIL` in `.env` must stay equal to the `email` of the
Keycloak user who browses the books — otherwise the bootstrap container mints its token for one
Firefly account and the human reads another.

**Identity** (`compose/keycloak/`) — Keycloak 26 with the A12 Project Template's own realm:
`A12Realm`, the public SPA client `a12-spa-client`, and the realm roles `admin`, `user`,
`systemAdmin` and `runtime`. Two clients are ours rather than the template's —
`assistants-runtime-client` (the only one with the direct access grant, for the Runtime and the
test tiers) and `firefly-oauth2-proxy` (confidential, for the proxy). `KC_HOSTNAME` pins the issuer
to `http://localhost:8089` so a token minted over the internal `keycloak:8080` address still
validates; without it the proxy, which redeems its authorization code internally, would get tokens
the ThingStore rejects. Realm import is create-only — editing these files changes nothing until
`just clean` drops the volume.

## The Things

Eight Models. The **Authority** column is the one system that owns that fact
([ADR-0006](docs/adr/0006-one-authority-per-fact.md)); the **Written by** column matters because
A12 has no optimistic locking, so every document has exactly one writer at any instant.

| Model | Authority | What it is | Written by |
|---|---|---|---|
| `Party` | ThingStore *(provisional)* | Anyone the household deals with — a person or an organisation, with a kind and a role | User and Runtime |
| `Document` | ThingStore | An item that has arrived but has not yet been understood, plus whatever text was extracted from it | User and Runtime |
| `Invoice` | ThingStore *(document facts only)* | The extracted invoice: issuer, number, dates, amounts, subject. **No `paid` field and no `bookkeepingRef`** | User and Runtime |
| `Process` | ThingStore | The routing slip — a title, a status and an append-only list of steps. Passive; nothing executes it | User and Runtime |
| `Assistant` | ThingStore | An Assistant's definition: key, system prompt, skills, triggers and the Tools it may use | **User only** — the Runtime reads it |
| `Conversation` | ThingStore | One run of one Assistant: status, what it is waiting for, turn count, and an append-only list of entries | **Runtime only** — the form is read-only |
| `OpenQuestion` | ThingStore | A question put to the User — `free-text`, `confirm`, `choice` or `perform` — and the User's answer to it | Runtime writes it once at creation, then **the User only** |
| `RuntimeState` | ThingStore | A singleton: the watcher's watermark, the pause flag, the births-per-hour counter, the heartbeat | **Runtime only** |

Every Model also carries `idempotencyKey`, `createdByConversationId`, `createdAt` and `updatedAt`.
The first is what makes creation retry-safe — the ThingStore assigns the identifier, so
`thingstore.create` is defined as *search-then-create*. The last two are ours rather than A12's
`__meta` because `__meta.createdAt` has second granularity with inclusive range bounds, which
double-counts the watermark boundary.

## Adding a Thing

Read [`import/models/CONVENTIONS.md`](import/models/CONVENTIONS.md) first — most of its rules exist
because the A12 query API is narrower than it looks, and breaking one produces a watcher that
silently returns nothing.

1. Create `import/models/<thing>/<Thing>_DM.json`. Lower-case singular folder; the model id matches
   the filename; `{"name": "roles", "value": "user,runtime"}` on the header; every label in both `en`
   and `de`.
2. Add the fields from the type cookbook. A12 has no integer, money or reference type: a reference
   to another Thing is an indexed `StringType` named `<what>ThingId`
   ([ADR-0002](docs/adr/0002-thingid-identifies-only.md)), money is a `NumberType` with
   `trait: "amount"`, and anything the Runtime filters on is a `StringType` carrying an ASCII code —
   never an `EnumerationType`, which A12 indexes by localised display text.
3. Annotate every filtered field `{"name": "indexed", "value": "true"}`, as a *sibling* of the
   `"Field"` key, not inside it.
4. End the root group with the four machine fields, in order.
5. Write `<Thing>_FM.json` binding directly to the document model
   (`purpose: "data binding"`), and `<Thing>_OM.json` over scalars only
   ([ADR-0008](docs/adr/0008-every-data-model-has-a-form-model.md)).
6. Add a module to `import/models/AssistantsAppModel_AM.json` so the Thing is navigable.
7. Name the Model's **Authority** ([ADR-0006](docs/adr/0006-one-authority-per-fact.md)). An unnamed
   Authority is a future disagreement.
8. If Assistants should be born from it, add it to the trigger-eligible allow-list in
   `runtime/src/watcher/watcher.ts`, and to `WRITABLE_MODELS` in `runtime/src/tools/tools.ts` if
   they should be able to create one.
9. `just test-models`, then `just build`.

## Design notes worth knowing

- **Waiting is never a running process.** An Assistant's entire state is its Conversation Thing, so
  a question that waits three weeks costs nothing and survives every restart
  ([ADR-0004](docs/adr/0004-assistants-suspend-and-resume.md)).
- **The ThingStore is the only integration surface.** The Runtime polls it and exposes no API; the
  UserInterface writes to it and calls nothing else. There is no second authority for pending work
  ([D-005](DECISIONS.md)).
- **The Conversation is an intent log, not a result log.** A tool call and its idempotency key are
  written *before* the operation executes, so recovery after a crash asks the connector whether the
  key landed rather than re-running it — which is the difference between a bug and booking €96.50
  twice.
- **One Authority per fact**, which is why an Invoice has no `paid` field and no reference to its
  booking: "is this paid?" and "how was this booked?" are both searches against Firefly, where the
  ThingID travels as `external_id` ([ADR-0006](docs/adr/0006-one-authority-per-fact.md)).
- **An Assistant declares its Tools**, one row per Operation, and a call to another Assistant is
  declared per callee as `assistant.call:<key>`; the registry filters the schemas offered to the
  model, so an undeclared Operation is not refused, it is invisible
  ([ADR-0010](docs/adr/0010-assistants-declare-their-tools.md)).
- **Assistants are Things you edit in the UI**, not code you deploy. Changing the Receptionist's
  prompt is editing a document in a markdown field
  ([ADR-0003](docs/adr/0003-assistants-are-things.md)).
- **Triggers give birth, responses continue.** The User answering, a Manual Connector reporting
  back and an Assistant calling another are one mechanism, not three
  ([ADR-0005](docs/adr/0005-triggers-give-birth-responses-continue.md)).
- **Exactly one Runtime replica**, and that is a constraint rather than a deployment convenience.
  A12 has no version, ETag or compare-and-swap anywhere, so `leaseUntil` on a Conversation is crash
  *recovery*, not mutual exclusion — two replicas would both claim an expired lease.
- **Nothing ends silently.** A terminal failure sets `waiting` and raises an Open Question carrying
  the error, capped at three per Conversation. `failed` therefore means only "the User abandoned
  it" — a state a human chose rather than one the system fell into.
- **A Manual Connector is not a special mechanism.** It returns pending and writes an Open
  Question, exactly as `ui.askUser` does. The Assistant cannot tell whether a machine or a human
  answered, which is what makes automating one later a connector-only change.

## Status and limitations

This is one running vertical slice, not a finished system. What is honestly missing:

- **Authentication is real, its configuration is development-grade.** The mechanism is the one A12
  intends — Keycloak as the identity provider, OIDC, no password checked anywhere else. No
  credential is committed any more ([D-023](DECISIONS.md)), but what is *generated* still is not
  production-ready: Keycloak runs `start-dev` over plain HTTP, its console is `admin` / `admin`,
  and the realm's password policy is relaxed far enough to allow `human` / `human` — the four
  login passwords in `.env.example` are development defaults, not generated secrets. Every one of
  those is deliberate for a stack published on `127.0.0.1`. Do not expose it beyond localhost
  without replacing all of them.
- **Firefly III trusts a header.** `remote_user_guard` performs no validation of `X-Forwarded-Email`
  whatsoever, so Firefly is only as protected as the network path to it. Inside the compose network
  it is wide open, which is what lets the Runtime and `firefly-bootstrap` use it; the security
  argument is entirely that it publishes no host port. Give it one and authentication is gone.
- **Email and Bank are Manual Connectors.** `email.send`, `email.fetch` and `bank.sendMoney` do not
  talk to anything; they raise an Open Question and the User does the work by hand and reports
  back. This is deliberate — ADR-0004 says the system must run end to end with every External
  System manual, and this is where that is proved — but it means no mail is fetched and no money
  moves.
- **Text extraction is not implemented.** A Document's `extractedText` is supplied by whoever
  creates the Document: the demo loader, or the User pasting text into the create form.
  `document.requestText` is a Manual Connector. OCR and PDF parsing are a later change.
- **No compaction, forking or steering** of Conversations. `maxTurns` (default 20) is the only
  bound on a long one, and reaching it raises an Open Question.
- **The transcript renders as a data grid.** A Conversation's entries are a read-only inline repeat
  in the ordinary A12 form. It is readable, but it is a table, not a transcript view.
  `just logs runtime` is the better debugging surface.
- **The end-to-end suite covers the slice, and writes to whatever stack it is pointed at.**
  `cd e2e && npx playwright test --list` is the authority on what it runs. Today: login as all four
  users, every module opened from the menu, Party CRUD, the Receptionist's prompt round-tripped
  through the markdown editor, localisation, the favicon, a row opened in each of the eight modules,
  the whole invoice slice (an arriving Document → an Open Question → an answer → the booking checked
  in Firefly) and surviving a restart of the Runtime and the store. Because it creates and deletes
  Things, point it at a development stack only.
- **Parties have no proper Authority.** CONTEXT.md assigns people to an address book. There is no
  address book External System, so the ThingStore holds them provisionally — a small, recorded
  violation of ADR-0006's spirit, to be reversed the day a connector exists.
- **`specs/changes/first-running-system/plan.md` is stale.** Only Phase 1 is ticked; phases 2 to 6
  are in fact built. Trust the code.

## Repository layout

```
/
├── justfile                  the command surface — every recipe is documented above
├── client/                   the A12 web application = UserInterface
│   └── src/components/markdown-editor/   lifted from w12-on-a12
├── server/                   the A12 Data Service = ThingStore (app/ and init/)
├── runtime/                  the Runtime: trigger watcher + loop driver (TypeScript)
│   ├── src/a12/              JSON-RPC client for the ThingStore
│   ├── src/llm/              provider interface + openai / anthropic / scripted
│   ├── src/loop/             advance() — one Conversation, one Turn
│   ├── src/watcher/          the six scans
│   ├── src/tools/            the Tool registry and the sixteen Operations
│   ├── src/connectors/       firefly
│   ├── src/bootstrap/        seeds the two Assistants and the RuntimeState singleton
│   ├── src/demo/             the demo household loader
│   └── fixtures/             the scripted LLM transcript
├── import/
│   ├── models/               the eight Things (DM/FM/OM) + the application model
│   ├── auth/                 roles.yaml — realm role → A12 access rights
│   └── validate-models.mjs   the model validator just test-models runs
├── .env.example              every credential the stack needs; just setup turns it into .env
├── compose/                  docker-compose.yml, the Firefly and postgres bootstrap scripts
│   └── keycloak/             the A12Realm import, as *.template + the renderer
├── scripts/setup-env.mjs     writes .env and generates the machine credentials
├── e2e/                      Playwright
├── specs/changes/            proposal, domain, architecture and plan, per change
├── docs/                     adr/ — fifteen architecture decision records; logo/ — design explorations
├── assets/                   the logo and its derived files
├── buildSrc/, quality/       Gradle build logic and the Checkstyle configuration
└── licenses/                 licence texts for the third-party notices
```

## Licence

EUPL-1.2 or a commercial licence from mgm technology partners GmbH — see [LICENSE](LICENSE),
[NOTICE](NOTICE) and [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
