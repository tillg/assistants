# Plan — first running system

Ordered so that the stack is runnable after every phase. Each phase ends with a commit.
Revised after grilling; see DECISIONS.md D-009 for the summary of what grilling changed.

## Phase 1 — Scaffold and prove the platform ✅

- [x] Vendor the A12 2026.06 local-auth project template into the repository root
- [x] Rename the template's placeholders to this project (`assistants`, `com.mgmtp.assistants`, `AssistantsAppModel_AM`, database names, nginx env vars)
- [x] Pin the public A12 registries in `.npmrc` and `settings.gradle` so the build works off-VPN (D-006)
- [x] Pin the toolchain (`.nvmrc` 24, `.sdkmanrc` JDK 21 / Gradle 9.5)
- [x] Merge `.gitignore`; drop mgm's copyright-header gate (D-008); drop the template's Person migration demo
- [x] Verify `gradle build` is green from the repo root

## Phase 2 — The models ✅

Conventions first, then eight Models. Every Model: `indexed` on watcher-filtered fields, machine
filters are Strings not Enums, own `createdAt`/`updatedAt`/`idempotencyKey`.

- [x] Write `import/models/CONVENTIONS.md` — id scheme, modelVersion values, the four query rules, the field/annotation cookbook
- [x] `Party_DM` / `_FM` / `_OM` — kind, role, name, contact fields, notes (markdown)
- [x] `Document_DM` / `_FM` / `_OM` — title, receivedAt, source, mediaType, extractedText (markdown), attachment, classification, createdByConversationId
- [x] `Invoice_DM` / `_FM` / `_OM` — issuer party ref, number, dates, amount, currency, subject, document ref, process ref; **no `paid`, no `bookkeepingRef`** (ADR-0006)
- [x] `Process_DM` / `_FM` / `_OM` — title, kind, status, steps group, related thing ids
- [x] `Assistant_DM` / `_FM` / `_OM` — key, prompts, llmModel, enabled, maxTurns, skills, triggers, tools
- [x] `Conversation_DM` / `_FM` / `_OM` — full state; form is **read-only**, entries as a read-only inline repeat
- [x] `OpenQuestion_DM` / `_FM` / `_OM` — Runtime writes the question, User writes the answer
- [x] `RuntimeState_DM` / `_FM` — singleton: watermark, watermarkDocRefs, paused, birth counters
- [x] `AssistantsAppModel_AM` — navigation for all of them, plus a dedicated **Open Questions** scene filtered on unanswered
- [x] Add the `runtime` user and role to `import/auth/` (D-007)
- [x] Remove the template's `Person` model, its seed request and its e2e specs
- [x] `gradle convertModels` passes; the stack starts and every model appears in the UI

## Phase 3 — The markdown editor ✅

- [x] Copy the editor tree from `w12-on-a12` @ `6b8df45`, dropping the collaborative subsystem
- [x] Also drop the CDD-coupled inline-attachment path (`AttachmentImage`, `collectImageAttachments`, `attachmentSource`, the `attachments-root` annotation; `ImageDialogPlugin` survives, rewritten to external URLs only) — our forms bind straight to their DM and have no CDD
- [x] Port `ModelElementBridge`, `widgetAnnotation`, `TextAreaStateless`, the colour-picker helper
- [x] Port the `markdownEditor` localisation keys (en, de)
- [x] Wire `formModelMap.Control` and `widgetMap.TextAreaStateless`; mount the global styles
- [x] Add the dependencies; verify `npm ls lexical` resolves to exactly one instance
- [x] Annotate the markdown fields (`widget=markdown-editor` + `exposition: AREA` + `lineBreaksPermitted`)
- [x] Port the editor's vitest suite (41 specs) and make it pass
- [x] Verify in the browser that an Assistant's `systemPrompt` round-trips markdown
- [x] Record the deliberate deviations in `MARKDOWN_FIELDS.md`

## Phase 4 — Bookkeeping in the stack ✅

- [x] Add the `firefly` service (SQLite, healthcheck, the two narrow volumes)
- [x] Add the one-shot `firefly-bootstrap` service: register the first user, mint a PAT to a shared volume
- [x] Verify the whole stack comes up healthy from cold with zero manual steps

## Phase 5 — The Runtime ✅

- [x] Scaffold `runtime/` (TypeScript, vitest, Dockerfile, env config)
- [x] A12 JSON-RPC client: `POST /api/v2/rpc`, batching, `UAABearer` auth, lazy re-login on 401
- [x] Typed Thing repository over the eight Models, with `thingstore.create` as **search-then-create** on `idempotencyKey`
- [x] `LlmProvider` interface + `OpenAiProvider`, `AnthropicProvider`, `ScriptedProvider`; selected by `LLM_PROVIDER` env
- [x] Tool registry with per-Assistant filtering (ADR-0010), including `assistant.call:<key>` and self-call rejection
- [x] ThingStore tools; `ui.askUser` writing an `OpenQuestion` and returning pending
- [x] `assistant.call` with `awaitMode: wait | chase | detach`
- [x] Firefly connector + `bookkeeping.*` tools, keyed by `external_id`, ThingID as a `thing:` tag
- [x] Manual Connector helper; `document.requestText`, `email.*`, `bank.sendMoney` on top of it
- [x] `advance()` — one Turn, leasing, **intent written before execution**, the pending path
- [x] Recovery: resolve an intent with no result by asking the Connector, never by re-executing
- [x] The failure policy: transient retry / model-recoverable tool-result / terminal Open Question
- [x] The runaway guards: trigger allow-list, `maxTurns`, `createdByConversationId`, `paused`, births-per-hour
- [x] The trigger watcher: all six scans, watermark in `RuntimeState`, birth-exactly-once via `(assistantKey, subjectThingId)`
- [x] Result delivery from a finished child to its parent, stamped with `resultDeliveredAt`
- [x] Add `runtime` to compose — **exactly one replica**

## Phase 6 — The Assistants and the demo data ✅

- [x] The **Receptionist** as a Thing: prompt, skills (classify, extract invoice fields), `thing-materialised` trigger on `Document`, tools
- [x] The **Accountant** as a Thing: prompt, skills (check an invoice, choose accounts, chase unpaid claims), **no `thing-materialised` trigger** — reached only by `assistant.call`
- [x] `runtime/src/bootstrap/` — loads what the system **is**: the two Assistants and the `RuntimeState` singleton. Idempotent. `just dev` runs it, so a fresh stack is alive and empty rather than inert
- [x] `runtime/src/demo/` — loads what the household **has**. A TypeScript loader, not a platform feature: pause → create in dependency order with authored `idempotencyKey`s → write the demo Conversations and OpenQuestions → advance the watermark past everything it created → unpause
- [x] Demo Things: parties, a renovation Process, a doctor's-invoice Process, Documents and Invoices in several states, one unanswered Open Question
- [x] Demo books: Firefly accounts, budgets and limits, and the transactions matching the booked invoices
- [x] `just demo-data` (idempotent); `just demo-reset` = `down -v` → `up` → `bootstrap` → `demo-data`, because Firefly has no bulk delete and its books live in a named volume — a full teardown is the only reset that is symmetric across two Authorities

## Phase 7 — Tests

- [x] Model validation, **both directions**: `elementRef` → field fails the build; field → `elementRef` warns about data-model fields no form model references, with an allow-list for the deliberately machine-owned ones (`idempotencyKey`, `leaseUntil`, …). This is the ADR-0008 hint, implemented — otherwise ADR-0008 is the only ADR this change leaves unexercised
- [x] Model validation: every `indexed` field the watcher uses exists
- [x] Runtime unit: birth, one Turn, tool dispatch, **tool gating (undeclared Tool)**, suspension on `askUser`, continuation on answer, `wakeAt` timeout, lease recovery **without re-execution**, one Invoice → exactly one Accountant Conversation, `maxTurns` → Open Question, late child result is a log line, self-call rejected
- [x] Integration against the live stack: A12 client CRUD + query, search-then-create idempotency, the Firefly connector, every watcher query
- [x] Playwright e2e with `LLM_PROVIDER=scripted`: log in, browse each overview, create an Invoice, edit an Assistant prompt in the markdown editor, answer an Open Question, confirm the transaction in Firefly
- [x] Heartbeat test: a scan that throws leaves the previous `heartbeatAt` stale, and the compose healthcheck goes unhealthy — silence must be recorded silence
- [x] Restart test (serial): suspend on an Open Question, `docker compose restart`, confirm it survives and still continues (ADR-0004)
- [x] Opt-in live-LLM tier, skipped without a key
- [x] `just test` runs every tier and is green

## Phase 8 — Documentation and wrap-up

- [x] README: what the system is, architecture diagram, prerequisites, quick start, **every `just` recipe documented**
- [x] Update `CONTEXT.md` with the terms domain.md added
- [x] New ADRs: the Runtime as a polling client; Party replacing Person; the local-auth template and public registries; the intent log and the idempotency contract
- [x] Record what the build settled in `MARKDOWN_FIELDS.md` and `AGENTIC_LOOP.md`
- [x] Adversarial code review, then fix what it finds
- [x] Present `DECISIONS.md`
