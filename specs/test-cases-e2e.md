# End-to-End Test Cases — autonomous QA run (2026-08-18)

Twenty end-to-end trips. Each creates or acts on data, follows it **cross-system** (UI ↔ server/ThingStore
↔ Runtime ↔ Firefly/LLM), and checks it landed in both the **server** (the Thing) and the **UI**.

Testing surface: web app at `http://localhost:8081` (login `admin` / `A12PT-admintest` or `human`/`human`),
ThingStore JSON-RPC at `http://127.0.0.1:8082/api/v2/rpc`, Firefly at `http://localhost:8084`, driven with the
live **local_qwen** model. Test-data Document/Party titles use prefix **`ETEST`** (NOT `E2E`, which the base
cleanup deletes; NOT the real `Fwd: Abschlagsrechnung` invoices).

| # | Name | What it exercises | Cross-system path | Server check | UI check |
|---|------|-------------------|-------------------|--------------|----------|
| 1 | **Invoice slice, happy path** | Inject an Arztrechnung Document → Receptionist classifies → Invoice → Accountant asks → answer → Runtime approval → book | UI/API → Runtime → LLM → Firefly | `Invoice_DM` with number/amount; Firefly transaction +1 | Open Question answered in Conversations; 🛑 clears |
| 2 | **Document created in the UI is picked up** | Create a Document by hand in the Documents form (no CreatedAt), confirm the watcher births a Receptionist Conversation | UI → server → Runtime | `Conversation_DM` born for the Document | new Conversation row appears |
| 3 | **Answer an Open Question in the UI** | Reach a pending question via Conversations → Answer → confirm+text → Save | UI → server → Runtime | `OpenQuestion` Confirmed+Text set, Conversation continues | 🛑 marker clears; transcript shows the answer |
| 4 | **Runtime approval gate (ADR-0018)** | The Assistant's own "book?" yes does NOT book; Runtime raises its own approval bound to exact args | Runtime refusal + re-ask | transcript `approval-request` entry; no Firefly txn until approved | second question appears; prompt names amount + accounts |
| 5 | **Refuse an approval** | Answer the Runtime approval with Confirmed=No | UI → Runtime | no Firefly transaction; Conversation ends without booking | question clears, no booking shown |
| 6 | **Restart mid-question** | Reach a pending question, `just restart runtime`, confirm the question survives and answering still continues | process kill | question row identical after restart | question still answerable |
| 7 | **Documents CRUD** | Create, search, edit, delete a Document in the UI | UI → server | Thing created/updated/deleted in `Document_DM` | row appears/updates/disappears; search finds it |
| 8 | **Parties CRUD** | Create a Party, edit its role, search, delete | UI → server | `Party_DM` reflects each op | overview + form reflect each op |
| 9 | **Invoices CRUD / manual invoice** | Create an Invoice by hand, edit amount, delete | UI → server | `Invoice_DM` values | overview shows values |
| 10 | **Processes: append-only steps** | Create a Process, confirm steps are append-only / status editable | UI → server | `Process_DM` steps grow, never rewrite | steps shown in order |
| 11 | **Operations catalogue kill switch** | Untick `Enabled` on an Operation → confirm a dependent Assistant loses the capability next Turn; re-enable | UI → server → Runtime gate | `Operation_DM` Enabled=false; Runtime refuses that op | toggle persists; catalogue shows state |
| 12 | **Operation requires-approval toggle** | Flip `Requires approval` on `bookkeeping.postTransaction` both ways | UI → server → Runtime | `Operation_DM` field; Runtime obeys | form reflects change |
| 13 | **Dashboard tiles** | Load Dashboard, verify all six tiles render with "as of HH:MM"; each links to its module/Firefly | UI → server → Runtime → Firefly | External Call to Firefly returns data | six tiles; counts non-empty; links navigate |
| 14 | **Dashboard money tiles degrade** | Stop the Runtime → Transactions & Accounts tiles grey out, other four stand; resume → they return | UI ↔ Runtime | External Call fails cleanly | two tiles grey, four fine |
| 15 | **Conversation transcript rendering** | Open a finished Conversation; verify bubble authorship, tool receipts collapse, pinned header, token cost | UI → server | Entries read | correct left/right/centre + receipt |
| 16 | **Markdown editor** | Edit an Assistant systemPrompt / a Notes field with headings, lists, tables, code, admonitions; save; reopen | UI → server | markdown persisted | rendered correctly on reload |
| 17 | **Localization** | Switch UI language; verify labels change and formats (dates/amounts) localize | UI | — | strings + number/date formats switch |
| 18 | **Attachment preview (preview-the-attachment)** | Open a Document whose attachment is a PDF; expect inline first-page preview OR graceful refused-state (filename + download); images still preview | UI → server `/cs` | ticket mint on `LOAD_ATTACHMENT_URL` | preview OR clean fallback, never blank iframe |
| 19 | **Mail letterbox ingestion** | Send an allowed-sender email with a PDF to the Gmail letterbox → Document with `Source: email`, `ExternalRef`, attachment; re-send same → idempotent (no dup) | Gmail → Runtime scan 0 → server | `Document_DM` `Source: email`; second poll creates nothing | Document appears in Documents overview |
| 20 | **Rejected / disabled letterbox** | Email from a non-allowlisted sender → moved to `assistants/rejected`, no Document; disabling the `email.receive` Operation stops polling | Gmail → Runtime | no Document created | nothing new in overview |

**Regression sweep alongside:** login/logout, navigation across all nine modules, forms open without error,
favicon, search on every overview, empty-state rendering, and error handling on malformed input.

**Bug bar:** a finding is a bug only if it is a defect in *our* code/models/config — reproducible and not a
local_qwen tool-emission flake (D3). Each confirmed bug → `/specs/bugs/NN-slug/` with repro, evidence, root cause.
