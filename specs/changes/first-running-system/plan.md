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

## Phase 2 — The models

Conventions first, then eight Models. Every Model: `indexed` on watcher-filtered fields, machine
filters are Strings not Enums, own `createdAt`/`updatedAt`/`idempotencyKey`.

- [ ] Write `import/models/CONVENTIONS.md` — id scheme, modelVersion values, the four query rules, the field/annotation cookbook
- [ ] `Party_DM` / `_FM` / `_OM` — kind, role, name, contact fields, notes (markdown)
- [ ] `Document_DM` / `_FM` / `_OM` — title, receivedAt, source, mediaType, extractedText (markdown), attachment, classification, createdByConversationId
- [ ] `Invoice_DM` / `_FM` / `_OM` — issuer party ref, number, dates, amount, currency, subject, document ref, process ref; **no `paid`, no `bookkeepingRef`** (ADR-0006)
- [ ] `Process_DM` / `_FM` / `_OM` — title, kind, status, steps group, related thing ids
- [ ] `Assistant_DM` / `_FM` / `_OM` — key, prompts, llmModel, enabled, maxTurns, skills, triggers, tools
- [ ] `Conversation_DM` / `_FM` / `_OM` — full state; form is **read-only**, entries as a read-only inline repeat
- [ ] `OpenQuestion_DM` / `_FM` / `_OM` — Runtime writes the question, User writes the answer
- [ ] `RuntimeState_DM` / `_FM` — singleton: watermark, watermarkDocRefs, paused, birth counters
- [ ] `AssistantsAppModel_AM` — navigation for all of them, plus a dedicated **Open Questions** scene filtered on unanswered
- [ ] Add the `runtime` user and role to `import/auth/` (D-007)
- [ ] Remove the template's `Person` model, its seed request and its e2e specs
- [ ] `gradle convertModels` passes; the stack starts and every model appears in the UI

## Phase 3 — The markdown editor

- [ ] Copy the editor tree from `w12-on-a12` @ `6b8df45`, dropping the collaborative subsystem
- [ ] Also drop the CDD-coupled inline-attachment path (`AttachmentImage`, `ImageDialogPlugin`, `collectImageAttachments`, `attachmentSource`, the `attachments-root` annotation) — our forms bind straight to their DM and have no CDD
- [ ] Port `ModelElementBridge`, `widgetAnnotation`, `TextAreaStateless`, the colour-picker helper
- [ ] Port the `markdownEditor` localisation keys (en, de)
- [ ] Wire `formModelMap.Control` and `widgetMap.TextAreaStateless`; mount the global styles
- [ ] Add the dependencies; verify `npm ls lexical` resolves to exactly one instance
- [ ] Annotate the markdown fields (`widget=markdown-editor` + `exposition: AREA` + `lineBreaksPermitted`)
- [ ] Port the editor's vitest suite (41 specs) and make it pass
- [ ] Verify in the browser that an Assistant's `systemPrompt` round-trips markdown
- [ ] Record the deliberate deviations in `MARKDOWN_FIELDS.md`

## Phase 4 — Bookkeeping in the stack

- [ ] Add the `firefly` service (SQLite, healthcheck, the two narrow volumes)
- [ ] Add the one-shot `firefly-bootstrap` service: register the first user, mint a PAT to a shared volume
- [ ] Verify the whole stack comes up healthy from cold with zero manual steps

## Phase 5 — The Runtime

- [ ] Scaffold `runtime/` (TypeScript, vitest, Dockerfile, env config)
- [ ] A12 JSON-RPC client: `POST /api/v2/rpc`, batching, `UAABearer` auth, lazy re-login on 401
- [ ] Typed Thing repository over the eight Models, with `thingstore.create` as **search-then-create** on `idempotencyKey`
- [ ] `LlmProvider` interface + `OpenAiProvider`, `AnthropicProvider`, `ScriptedProvider`; selected by `LLM_PROVIDER` env
- [ ] Tool registry with per-Assistant filtering (ADR-0010), including `assistant.call:<key>` and self-call rejection
- [ ] ThingStore tools; `ui.askUser` writing an `OpenQuestion` and returning pending
- [ ] `assistant.call` with `awaitMode: wait | chase | detach`
- [ ] Firefly connector + `bookkeeping.*` tools, keyed by `external_id`, ThingID as a `thing:` tag
- [ ] Manual Connector helper; `document.requestText`, `email.*`, `bank.sendMoney` on top of it
- [ ] `advance()` — one Turn, leasing, **intent written before execution**, the pending path
- [ ] Recovery: resolve an intent with no result by asking the Connector, never by re-executing
- [ ] The failure policy: transient retry / model-recoverable tool-result / terminal Open Question
- [ ] The runaway guards: trigger allow-list, `maxTurns`, `createdByConversationId`, `paused`, births-per-hour
- [ ] The trigger watcher: all six scans, watermark in `RuntimeState`, birth-exactly-once via `(assistantKey, subjectThingId)`
- [ ] Result delivery from a finished child to its parent, stamped with `resultDeliveredAt`
- [ ] Add `runtime` to compose — **exactly one replica**

## Phase 6 — The Assistants and the demo data

- [ ] The **Receptionist** as a Thing: prompt, skills (classify, extract invoice fields), `thing-materialised` trigger on `Document`, tools
- [ ] The **Accountant** as a Thing: prompt, skills (check an invoice, choose accounts, chase unpaid claims), **no `thing-materialised` trigger** — reached only by `assistant.call`
- [ ] `runtime/src/demo/` — a TypeScript loader, not a platform feature: pause → create in dependency order with authored `idempotencyKey`s → write the demo Conversations and OpenQuestions → advance the watermark past everything it created → unpause
- [ ] Demo Things: parties, a renovation Process, a doctor's-invoice Process, Documents and Invoices in several states, one unanswered Open Question
- [ ] Demo books: Firefly accounts, budgets and limits, and the transactions matching the booked invoices
- [ ] `just demo-data` (idempotent) and `just demo-reset`

## Phase 7 — Tests

- [ ] Model validation: every model converts, every `elementRef` resolves, every `indexed` field the watcher uses exists
- [ ] Runtime unit: birth, one Turn, tool dispatch, **tool gating (undeclared Tool)**, suspension on `askUser`, continuation on answer, `wakeAt` timeout, lease recovery **without re-execution**, one Invoice → exactly one Accountant Conversation, `maxTurns` → Open Question, late child result is a log line, self-call rejected
- [ ] Integration against the live stack: A12 client CRUD + query, search-then-create idempotency, the Firefly connector, every watcher query
- [ ] Playwright e2e with `LLM_PROVIDER=scripted`: log in, browse each overview, create an Invoice, edit an Assistant prompt in the markdown editor, answer an Open Question, confirm the transaction in Firefly
- [ ] Restart test (serial): suspend on an Open Question, `docker compose restart`, confirm it survives and still continues (ADR-0004)
- [ ] Opt-in live-LLM tier, skipped without a key
- [ ] `just test` runs every tier and is green

## Phase 8 — Documentation and wrap-up

- [ ] README: what the system is, architecture diagram, prerequisites, quick start, **every `just` recipe documented**
- [ ] Update `CONTEXT.md` with the terms domain.md added
- [ ] New ADRs: the Runtime as a polling client; Party replacing Person; the local-auth template and public registries; the intent log and the idempotency contract
- [ ] Record what the build settled in `MARKDOWN_FIELDS.md` and `AGENTIC_LOOP.md`
- [ ] Adversarial code review, then fix what it finds
- [ ] Present `DECISIONS.md`
