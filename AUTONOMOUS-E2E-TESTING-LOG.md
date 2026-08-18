# Autonomous End-to-End Testing & Bug-Hunt Log

Started: 2026-08-18. Running unattended per `/autonomous`.

## The task (as given)

1. Write a list of 20 test cases (end-to-end trips: data created → processed → cross-system → server + UI).
2. Wait for fellow agents to finish.
3. Make sure all is committed and pushed.
4. Test end-to-end by remote-controlling the browser (Playwright MCP).
5. Test with the **local LLM** (`local_qwen` profile).
6. Create test data freely, including creating emails in the Gmail account.
7. Restart Rancher Desktop if needed.
8. Run tests until at least **20 bugs** are found.
9. Document bugs in `/specs/bugs/...`.
10. Fix them one by one, commit & push after every bug.
11. Fixed bug folders get a `-fixed` suffix.

## Environment observed at start

- Stack already **up** (containers running ~11h; runtime restarted ~2 min before I started — the peer session):
  - frontend `127.0.0.1:8081`, server `127.0.0.1:8082`, keycloak `127.0.0.1:8089`,
    postgres `127.0.0.1:8083`, firefly-proxy `127.0.0.1:8084`.
  - Local LLM (mlx/omlx) answering on `http://localhost:8000/v1` (asks for API key — expected).
- `llm.json` active profile = `local_qwen` (Qwen3-Coder-30B). Matches the "test with the local llm" instruction.
- A peer Claude session (`assistants [a09f06]`) is **busy**; uncommitted changes in
  `runtime/src/loop/advance.ts` and `runtime/test/loop.test.ts` — presumed theirs. I messaged them
  and will wait before committing/pushing.

## Decisions & assumptions (running list)

- **D1** — I will NOT commit/push the peer's uncommitted `advance.ts`/`loop.test.ts` changes. I wait
  for the peer to finish and land their own work first, per the task ordering ("wait for fellow
  agents… then make sure all is committed and pushed").
- **D2** — "Test with the local llm" → keep `llm.json` active = `local_qwen`. I will not switch to a
  scripted or cloud model for the exploratory browser testing (the scripted model is only for the
  deterministic `test-e2e` suite). Confirmed with peer: do NOT change `active` in llm.json (their
  standing decision too; it's the user's gitignored file).
- **D3** — `local_qwen` (4-bit Qwen3-Coder) is *probabilistic* about wrapping tool calls in
  `<tool_call>` tags. A Turn failing with "emitted a tool call as text" is a **model limitation, not
  a code bug**. I will verify the raw model response before ever filing such a symptom as a bug.
- **D4** — Baseline confirmed green before any change: peer's `just test` = 420 pass/1 skip; my
  `just check` (tsc+lint) = exit 0. HEAD = origin/main = da306ff.
- **D5** — Live-Gmail letterbox polls every 60s; three real invoice Documents (`Fwd: Abschlagsrechnung
  RE0520 …`) + their Conversations exist. These are background drift — never delete, never count as
  my own test data. My test-data Document titles use a distinct prefix (`ETEST`), NOT `E2E` (which
  the base cleanup setup deletes) and NOT the real invoice titles.

## Test cases

Written to `specs/test-cases-e2e.md` (20 cases). Live results so far (driven via Playwright MCP, live local_qwen):

- **TC1 (invoice slice, local LLM)** ✓ — my UI-created Document was classified, an `Invoice` extracted
  correctly by Qwen (number `UITEST-001`, gross 42, issuer/dates/recipient all right). Full slice runs.
- **TC2 (UI-created doc picked up)** ✓ — Document created in the form with no `CreatedAt` was stamped by
  the Runtime and a receptionist Conversation was born and reached `done` (4 turns).
- **TC7 (Documents create)** ✓ — created via Add form, appears at top of overview + in ThingStore.
- **TC13 (dashboard)** ✓ — all six tiles render with "as of HH:MM"; money tiles show live Firefly data.
- **TC17 (localization)** ✓ — EN→DE switches all labels and date format (`18.08.2026 10:56`).
- Observed: **514 Conversations in flight / 273 waiting on you** — the known unbounded standing-population
  fragile area, amplified by flaky-model escalations. Not itself my finding.

## Candidate bugs (verified against code before filing)

- **CB-scan5** (scan 5 result delivery: unordered 100-cap, no cursor) — CONFIRMED in
  `runtime/src/watcher/watcher.ts` `scanResultDelivery`. `scanAnswered` got the cursor+ordering fix;
  scan 5 did not. Sticky undeliverable children (deleted parent) permanently shadow deliverable ones.
- **CB-scan3/4** (scan 3 `scanWoken` + scan 4 `scanExpiredLeases`: unordered 100-cap) — CONFIRMED same
  shape; due wake-ups past row 100 can be stranded. Lower severity than scan 5.
- **CB-pendingQM** (`OpenQuestionPending_QeM` filters on `AnsweredAt`, which nothing ever stamps →
  answered questions never leave the pending overview) — CONFIRMED constraint; but the overview is not in
  the nav menu, so current user impact is low (latent). Referenced only by `OpenQuestion_OM`.

## Final summary (all done)

- **20 / 20 bugs fixed**, each: documented in `specs/bugs/NN-slug/`, fixed with a focused test where
  the harness allowed, committed as its own `fix(...)` commit, pushed to `origin/main`, folder renamed
  `-fixed`. One follow-up `style(...)` commit fixed an eslint-curly nit the batch `just check` caught.
- **Verification, all green:** runtime suite **430 passed / 1 skipped**; client suite **571 passed**;
  `just check` (runtime+client tsc, eslint, prettier, 29 models, check-docs) **exit 0**.
- Method: the peer had already exhaustively covered mail/firefly/watermark/advance.ts (30 findings), so
  I hunted the **least-scrutinised** areas — client UI, the non-mail watcher scans, operations/gate,
  the llm/turn layer, markdown round-trips, setup/demo scripts — combining live browser+API testing
  with targeted read-audits, and verified every finding against the real code before filing.
- Live testing (Playwright MCP + live `local_qwen`) confirmed: login, dashboard (6 tiles), Documents
  create, a UI-created Document being classified end-to-end by the local model (Invoice extracted
  correctly), localization EN↔DE, the Conversations overview + answer surface, and the ADR-0018
  approval gate holding. The one live "failure" (accountant giving up) was a **local_qwen hallucination**
  (fabricated invoice id), not a code bug (D3) — no unapproved booking occurred.

## Decisions & assumptions (final)

- **D6** — Documented all 20 first (one `docs(qa)` commit), then fixed one-by-one — the task's ordering.
- **D7** — Committed directly to `main` (the task says "commit & push after every bug"; branching was
  not permitted — global rule). Matches how the peer landed its work.
- **D8** — **Bug 14 (transcript i18n)** was the one finding whose full fix rivals several others. A
  *partial* localization would leave the transcript inconsistently bilingual (worse than uniform
  English), and the whole bespoke-React layer (dashboard tiles included) is English-only by a consistent
  design stance. I scoped the fix to the **conversation transcript feature** (its prominent header +
  Answer strings), wired through the existing resource-bundle mechanism with EN values identical to the
  old literals (so nothing English moved) and DE added + tested. Date separators and the wider
  bespoke-React layer remain English — noted in the bug folder as follow-up.
- **D9** — **Bug 18 (demo budgets)** could only be *live*-verified with a fresh Firefly (`demo-reset`),
  which wipes the household's real books (the three real invoice Documents + their bookings). I did NOT
  run it; the fix is verified by reasoning (the connector already maps `budgetName`→`budget_name`; the
  widened Health window now covers the demo's health-invoice dates). Flagged for the user to confirm.
- **D10** — Did **not** re-report/re-fix the peer's already-handled findings, nor the deliberately-OPEN
  ones (registry idempotency B-10, BUG-23 read-half, the E2E-title-prefix delete B-28, the suspend-drops
  -remaining-toolcalls note which is the peer's loop-driver area). Listed under "Not filed" below.
- **D11** — After all fixes, rebuilt the stack (`just build` + restart) to redeploy the changes into the
  running containers and smoke-test the browser-observable ones live. (The unit/integration suites are
  the real verification for the non-visible fixes — scan ordering, reconcile, markdown round-trips.)

## For the user to review

- **Bug 18** wants a live check on a fresh Firefly (`just demo-reset`) — destructive, so I left it.
- **Bug 14** is a *scoped* i18n fix (transcript feature only); extending it to the dashboard tiles and
  date separators is a reasonable follow-up if full German coverage is wanted.
- **Bug 10** fixes a query for an overview that is currently not in the nav menu (latent); worth a glance.

## Bugs found — the 20

Found by combining live browser/API testing with targeted code audits over the *least-scrutinized*
areas (the peer had already exhaustively covered mail/firefly/watermark/advance.ts). Each was verified
against the actual code before filing. Folder gets `-fixed` once its fix is committed + pushed.

| # | slug | area | sev | one-line |
|---|------|------|-----|----------|
| 01 | scan5-result-delivery-unordered-cap | runtime/watcher | HIGH | scan 5 delivery has unordered 100-cap + sticky rows → parents wait forever |
| 02 | time-scans-unordered-cap | runtime/watcher | MED | scan 3 (woken) / 4 (leases) unordered 100-cap can strand due rows |
| 03 | thingstore-update-machine-fields | runtime/operations | MED | `thingstore.update` lets a model overwrite idempotencyKey/createdAt/createdBy |
| 04 | thingstore-search-limit-bounds | runtime/operations | LOW | `search` limit accepts negative/fractional → opaque store error |
| 05 | ui-askuser-kind-unvalidated | runtime/operations | LOW | `ui.askUser` accepts any `kind`, can mint a `perform` question |
| 06 | readscan-reconcile-false-success | runtime/operations | MED | interrupted `replace:true` re-read reconciles as success on stale text |
| 07 | tool-intent-prose-duplicated | runtime/llm | MED | assistant prose copied onto every tool-intent → replayed N times |
| 08 | abnormal-finish-reason-answered | runtime/llm | MED | `content_filter`/unknown finish_reason → Conversation `done` empty |
| 09 | markup-tool-call-dialect-mismatch | runtime/llm | LOW | markup detector admits a dialect the recoverer can't read → burns retries |
| 10 | pending-questions-never-clear | models | MED | `OpenQuestionPending_QeM` filters on never-stamped `AnsweredAt` |
| 11 | receipt-pairing-mismatch | client/conversation | MED | Receipt pairs a result to the wrong same-tool intent |
| 12 | assistants-tile-overcount | client/dashboard | LOW | "and N more" over-counts when an entry is filtered out |
| 13 | bubble-collapsed-footnote | client/conversation | LOW | token footnote renders on a collapsed bubble whose text is hidden |
| 14 | transcript-not-localized | client/conversation | LOW | transcript strings hardcoded English in a localized UI |
| 15 | color-directive-bracket-corruption | client/markdown | MED | colored text containing `]` corrupts on save→reload |
| 16 | admonition-fence-early-close | client/markdown | MED | a `:::` inside a panel body closes the container early on reload |
| 17 | table-cell-backslash-n | client/markdown | MED | literal `\n` typed in a table cell becomes a newline on reload |
| 18 | demo-budget-not-assigned | runtime/demo | MED | demo bookings carry no budget → budget report shows €0 spent |
| 19 | setup-env-write-before-validate | scripts | LOW | `setup-env.mjs` writes `.env` before validating → poisoned + guarded |
| 20 | check-docs-adr-count | scripts | LOW | `check-docs.mjs` breaks once there are ≥26 ADRs |

Not filed (deliberately): known-OPEN B-10 (registry idempotency), BUG-23 read-half, B-28 title-prefix
delete, suspend-drops-remaining-toolcalls (peer's loop-driver area), markdown header-off-row-0 (documented
deliberate GFM limitation). Model hallucinating a fake invoice id in the accountant handoff = local_qwen
limitation (D3), not a code bug.
