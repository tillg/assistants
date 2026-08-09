# Plan — first running system

Ordered so that the stack is runnable after every phase. Each phase ends with a commit.

## Phase 1 — Scaffold and prove the platform

- [ ] Vendor the A12 2026.06 local-auth project template into the repository root (client, server, import, compose, e2e, gradle build, buildSrc)
- [ ] Rename the template's placeholders to this project (`assistants`, `com.mgmtp.assistants`, `AssistantsAppModel_AM`, database names, nginx env var)
- [ ] Pin the public A12 registries in `.npmrc` and `settings.gradle` so the build works off-VPN (D-006)
- [ ] Add `.nvmrc` / `.sdkmanrc` pinning Node 24, JDK 21+, Gradle 9.5
- [ ] Extend `.gitignore` for `build/`, `node_modules/`, `.env`, generated model output
- [ ] Verify `gradle build` succeeds from a clean checkout
- [ ] Write the first `justfile` with `dev`, `clean`, `ps`, `logs` and verify `just dev` brings the template stack up healthy

## Phase 2 — The models

- [ ] `Party_DM` / `_FM` / `_OM` — kind, role, name, contact fields, notes (markdown)
- [ ] `Document_DM` / `_FM` / `_OM` — title, receivedAt, source, mediaType, extracted text (markdown), attachment, classification result
- [ ] `Invoice_DM` / `_FM` / `_OM` — issuer party ref, number, dates, amount, currency, subject, document ref, process ref, bookkeepingRef; **no payment status** (ADR-0006)
- [ ] `Process_DM` / `_FM` / `_OM` — title, kind, status, steps group (title, state, note, doneAt), related thing ids
- [ ] `Assistant_DM` / `_FM` / `_OM` — key, name, description, systemPrompt (markdown), llmModel, enabled, skills group, triggers group, tools group
- [ ] `Conversation_DM` / `_FM` / `_OM` — the full state from architecture.md including entries, open question and answer
- [ ] `AssistantsAppModel_AM` — navigation for all six, plus a dedicated **Open Questions** overview
- [ ] Replace the template's `Person` model and its e2e tests
- [ ] `gradle convertModels` passes; the stack starts and every model appears in the UI

## Phase 3 — The markdown editor

- [ ] Copy the editor tree from `w12-on-a12`, dropping the collaborative subsystem
- [ ] Port `ModelElementBridge`, `widgetAnnotation`, `TextAreaStateless` and the colour-picker helper
- [ ] Port the `markdownEditor` localisation keys (en, de)
- [ ] Wire `formModelMap.Control` and `widgetMap.TextAreaStateless` in `appsetup.ts`; mount the global styles
- [ ] Add the markdown dependencies and verify `npm ls lexical` resolves to exactly one instance
- [ ] Annotate the markdown fields in the form models (`widget=markdown-editor` + `exposition: AREA`)
- [ ] Port the editor's vitest suite and make it pass
- [ ] Verify in the browser that an Assistant's `systemPrompt` renders the rich editor and round-trips markdown

## Phase 4 — Bookkeeping in the stack

- [ ] Add the `firefly` service to the compose file (SQLite, healthcheck, volumes)
- [ ] Add the one-shot `firefly-bootstrap` service that registers the first user and mints a PAT to a shared volume
- [ ] Verify the whole stack comes up healthy from cold with zero manual steps

## Phase 5 — The Runtime

- [ ] Scaffold `runtime/` (TypeScript, vitest, Dockerfile, config from environment)
- [ ] A12 JSON-RPC client: local-auth login, `ADD_DOCUMENT`, `GET_DOCUMENT`, `UPDATE_DOCUMENT`, `DELETE_DOCUMENT`, query
- [ ] Thing repository layer typed to our six models
- [ ] `LlmProvider` interface with `OpenAiProvider`, `AnthropicProvider` and `ScriptedProvider`
- [ ] Tool registry with per-Assistant filtering by the declared `tools[]` (ADR-0010)
- [ ] ThingStore tools: create, get, update, search
- [ ] `ui.askUser` — writes the Open Question and returns `pending`
- [ ] `assistant.call` — births a child Conversation, returns `pending` (ADR-0007)
- [ ] Firefly connector + `bookkeeping.*` tools
- [ ] Manual Connector helper; `email.*` and `bank.*` built on it
- [ ] `advance(conversation)` — one Turn, with leasing, suspension and the pending path
- [ ] The trigger watcher: all six scans, with a stored high-water mark
- [ ] Result delivery from a finished child Conversation back to its parent
- [ ] Add `runtime` to the compose file and wire it to the stack

## Phase 6 — The Assistants and the demo data

- [ ] Write the **Receptionist** as a Thing: prompt, skills (classify, extract invoice fields), triggers, tools
- [ ] Write the **Accountant** as a Thing: prompt, skills (check an invoice, choose accounts, chase unpaid claims), triggers, tools
- [ ] Demo Things: parties, a renovation Process, a doctor's-invoice Process, several Documents and Invoices in different states
- [ ] Demo books: Firefly accounts (checking, payables, receivables, health, renovation), budgets and limits
- [ ] `just demo-data` loads both halves idempotently against a running stack
- [ ] `just demo-reset` clears and reloads

## Phase 7 — Tests

- [ ] Model validation test: every model converts and every `elementRef` resolves
- [ ] Runtime unit tests: birth, one Turn, tool dispatch, tool gating, suspension on `askUser`, continuation on answer, `wakeAt` timeout, lease expiry recovery, child-to-parent result delivery, finish reasons
- [ ] Integration tests against the live stack: A12 client CRUD + query, Firefly connector against the real container, watcher queries
- [ ] Playwright e2e: log in; browse each overview; create an Invoice; edit an Assistant prompt in the markdown editor; answer an Open Question; confirm the transaction in Firefly
- [ ] A restart test: suspend on an Open Question, `docker compose restart`, confirm the question survives and answering still continues the Conversation (ADR-0004)
- [ ] Opt-in live-LLM tier, skipped when no API key is present
- [ ] `just test` runs every tier and is green

## Phase 8 — Documentation and wrap-up

- [ ] README: what the system is, the architecture diagram, prerequisites, quick start, and **every `just` recipe documented**
- [ ] Update `CONTEXT.md` with the terms domain.md added (Runtime, Trigger Watcher, Loop Driver, Turn, Entry, Finish Reason, Pending Tool Call, wakeAt, Party, Document, Open Question kinds)
- [ ] New ADRs for the decisions that qualify: the Runtime as a polling client of the ThingStore; Party replacing Person; the A12 local-auth template and public registries
- [ ] Answer what the build settled in `MARKDOWN_FIELDS.md` (Q2 in particular) and `AGENTIC_LOOP.md`
- [ ] Final review pass: adversarial code review, then fix what it finds
