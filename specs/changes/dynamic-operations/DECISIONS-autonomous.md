# Autonomous run — decisions & assumptions (dynamic-operations)

Running `/spec:apply dynamic-operations` autonomously. This file records every decision or assumption
I made without user input, for review at the end.

## Context
- Two peer Claude sessions are active in the same repo: one on `preview-the-attachment` (owns the
  dirty `client/*`, `compose/docker-compose.yml`, `client/nginx.conf.template`, `webpack.dev.js`,
  `e2e/*` changes), and one referenced as `027acc`. I coordinate the shared Docker/Rancher stack with
  them (no `just down/build`/Rancher-restart without pinging).
- `DECISIONS.md` was already dirty at the point autonomous mode began (not my edit — a peer's or
  ui-changes'). I will re-read it fresh before editing in step 11 and merge rather than clobber.

## Decisions made autonomously

### Worker-thread execution across environments (step 5)
- The Operation Host spawns a worker per execution. To run a TypeScript worker under vitest, tsx-dev,
  and compiled prod alike: if `import.meta.url` ends in `.ts` (dev/test), spawn an `eval:true` worker
  whose bootstrap does `import { register } from 'tsx/esm/api'; register(); await import(worker.ts)`.
  If `.js` (compiled prod, devDeps pruned), spawn `worker.js` directly. Verified the tsx-register
  bootstrap works under vitest via a spike.
- Terminate timer = `timeoutMs + 3000ms` spawn allowance. The worker `terminate()` is the real bound
  for async/sync loops; the vm `timeout` only guards the synchronous definition prefix.

### DroppedGrant reasons (step 6)
- Added THREE reasons, not the two named in the plan: `ambiguous`, `uncompilable`, AND
  `unconfigured-egress`. The plan names only the first two but its own step-6 test requires dropping a
  dynamic Thing that names an undefined egress "with the egress named"; the `DROP_REASONS` record is
  exhaustive over the union, so the egress case needs its own reason. The egress NAME reaches the log
  (via `drop()`'s detail), not the `DroppedGrant` object — because existing tests assert `dropped`
  with exact `toEqual([{key, reason}])` and adding a `detail` field would break them.

### Registry ↔ Operation Host wiring (step 6)
- `OperationRegistry` takes an optional `OperationHost` (constructor). Optional so bare built-in-only
  test registries still construct; production always wires it in `buildRuntime`. A dynamic Thing met
  with no host drops as `unimplemented`.
- `declaresReconcile` uses a static regex scan of the compiled code (never executes source in the
  main thread) — it drives only an advisory warning, so a rare miss costs a spurious warning, never
  correctness.

### Inbound gate (step 7)
- `decide()` gained an optional `thing?: Operation` param (kept pure — the caller fetches). Built-in
  keeps `verdict.implementation`; the allowed verdict now also carries an `execute` closure, and
  `server.ts` calls `verdict.execute(...)` (works for both kinds).
- `server.ts` now fetches the Operation Thing once (`findOperation`, replacing `isEnabled`) and uses
  it for both the gate's dynamic flags and the `Enabled` check. A store failure → `undefined` → fails
  closed. Two Things with one key → `"ambiguous"` → refused.

### Config / egress table (step 5)
- `EgressConfig` holds `{url, token, tokenFile?}`; the token file is read lazily by the host at first
  use (mirrors FireflyConnector), not eagerly at config load — keeps `loadConfig` side-effect-free
  and testable. `bookkeeping` egress defaults to the Firefly variables so an existing deployment needs
  no new env. `EGRESS_<NAME>_*` scan builds the rest.

### Pre-existing dead code noticed (not touched — surgical)
- `runtime/src/config.ts`: `GMAIL_HOST` const and `gmailReady` local are unused (pre-existing, from
  the mail-transport work). Left as-is per the surgical-changes rule; flagged here.

### Step 8 — bookkeeping.* as Source
- **No `describeCall` for dynamic Operations.** `describeCall` is synchronous (`advance.ts:294`), but
  stored source runs asynchronously in a worker, and the architecture says `advance.ts` gains nothing.
  So `postTransaction`'s approval prompt falls back to the default rendering (operation name + JSON
  args block). The approval is still fully enforced (`requiresApproval` read from the Thing). This is
  the one user-visible regression; a follow-up could add a synchronous `describe` mode. NOT in the
  plan's "must survive" list.
- **Dropped `external_url`** (the Firefly-UI backlink on a posting): the sandbox has no `uiBaseUrl`
  (egress gives only Firefly's base URL + token). Kept the `thing:<id>` tag, which is what traceability
  and any future same-thing search rely on.
- **Dropped `findSamePostingForThing`** (content-compare search by thing tag) and the
  **duplicate-hash-victim re-post** (re-POST with `error_if_duplicate_hash:false` over a deleted
  transaction's hash). Neither is in the plan's "what has to survive" table. Kept:
  `error_if_duplicate_hash: true` on the POST (Firefly's own duplicate guard), the `external_id`
  probe (`findByExternalId`) + `reconcile`, and the 422 translation. Consequence: re-booking an
  identical posting after deleting the original returns a Firefly "duplicate of #N" error the model
  surfaces to the User — a rare edge case, documented.
- **`postsInFlight` single-flight map dropped** (as the plan directs): covered by `external_id` + the
  single Runtime replica.
- **getBudgetReport does its two GETs sequentially** (budgets, then budget-limits) rather than in
  parallel (`Promise.all`), for readability — the whole point is that the Source shows the HTTP. Minor
  latency cost, no behavior change.
- **Source files are plain JavaScript in `.ts` files**, no type annotations (the User reads them; the
  Operation Host strips types but does not typecheck). The editor LSP flags them ("implicitly any",
  "duplicate execute across files", etc.) because it treats orphan `.ts` files as one typechecked
  program — but NO tsconfig includes `import/` (runtime = `src/**`+`test/**`, client = `src/**`, e2e =
  its own dir), so `just check` never typechecks them and they are stripped, not compiled. Harmless.
- **Shared prelude is prepended to each Operation's stored source** (concatenation at seed/test time),
  since dynamic source has no module system. `import/operations/bookkeeping/prelude.ts` holds the
  shared helpers; each `<op>.ts` holds only its `execute`/`reconcile`.

### Step 9 — bootstrap and the switch
- **`implementation` is on the mirror side** (re-applied by bootstrap); `source`, `language`,
  `egress`, `timeoutMs`, `clientReadable` are decision-side (created once). `mutating` stays on the
  mirror (re-applied) for all ops — for a dynamic op the registry still reads it off the Thing at
  runtime, but bootstrap keeps it synced to the seed, which is the safe behavior.
- **`clientReadable: true` only on `listAccounts` + `listTransactions`** (the two allowlisted
  Dashboard reads). `getBalance` was `clientReadable` in the old code but was never on the deployment
  allowlist, so it loses the flag with no behavior change.
- **The migration embeds each Operation's Source** (installed Things carry none, and bootstrap never
  re-applies decision fields to existing Things). It is GENERATED from the source files by
  `scripts/generate-bookkeeping-migration.mjs` (dollar-quoted blobs, one atomic idempotent UPDATE
  with CASE-per-key), so the embedded Source matches the seed byte-for-byte and bootstrap reports no
  divergence. Regenerate rather than hand-edit.
- **bootstrap.test VICTIM changed** from `bookkeeping.createAccount` (now dynamic, gone from
  `buildOperations`) to `email.receive` (mutating, granted to nobody). Added four dynamic-seed tests.
- **Deleting the 7 compiled bookkeeping impls broke 39 unit tests** across loop.test, operations.test,
  and inbound/*.test that referenced the compiled ops. Re-pointing/replacing them is in progress; the
  bookkeeping *behavior* is now covered by `dynamicBookkeeping.test.ts`, the gate by `gate.test.ts`.
- **Orphaned helpers left in implementations.ts** (ISO_DATE, describeRejection, projectTransactionGroup,
  describePosting, currentMonth, FIREFLY_FIELD_NAMES, the firefly dep) — cleaned in step 10 per the plan.
- **Test harness rewired for the dynamic path (big decision).** All `requiresApproval` and
  `clientReadable` operations became dynamic, so the approval machinery (loop.test) and the inbox
  machinery (server.test, clientReadable.test) can only be exercised against dynamic ops. Rather than
  lose that coverage or fake it, the harness now runs the seven dynamic bookkeeping ops through the
  REAL Operation Host against an in-process Firefly HTTP fixture (`support/fireflyFixture.ts`),
  matching the plan's "one layer out" philosophy. `buildHarness` stays synchronous: the fixture is
  started per-file in `beforeAll` and its URL handed to the harness via `setFireflyUrl()` (module
  global) / a `fireflyUrl` option; the seven dynamic Operation Things (with source) are added to the
  seeded catalogue. `harness.firefly` is now the fixture (exposing `.posted`, `.failNextPost`,
  `.accounts` for the tests that inspect them).
- **Superseded pure-behavior tests deleted**, their coverage now in `dynamicBookkeeping.test.ts`:
  the `bookkeeping.postTransaction` 422 describe in operations.test, the `bookkeeping.listTransactions`
  describe in inbound/bookkeepingQuery.test, and inbound/listAccountsFilter.test.
- **Approval-prompt assertions updated**: with no `describeCall` on a dynamic op, the prompt is the
  JSON fallback — which still contains the account names and amounts (they are in the args), so most
  assertions hold; the euro-sign and "no ```json" assertions were updated to the fallback's shape.

### Step 10 — the live proof
- **FireflyConnector was NOT stripped to `isReachable()` (deviation from the plan).** The plan's
  step 10 says strip it and delete the operation-serving methods, but `runtime/src/demo/cli.ts` uses
  its `listAccounts`, `createAccount`, `listBudgets`, `createBudget`, `postTransaction` to seed the
  demo household, and `isReachable` is the health check. Fully stripping it would break `just demo-data`
  and require rewriting the demo loader (a separate change with its own surface). The core acceptance
  criterion is already met: no Operation calls the connector — the seven are dynamic. The connector is
  now dead code *from the Operations' perspective*, live only as a demo/setup + health client. Stripping
  it (and rewriting demo/cli.ts) is a clean follow-up. Recorded as a deliberate scope boundary.
- **`implementations.ts` orphan cleanup done**: removed the helpers only the deleted compiled ops used
  (ISO_DATE, TRANSACTIONS_LIMIT_MAX, FIREFLY_FIELD_NAMES, describeRejection, projectTransactionGroup,
  describePosting, money, currentMonth) and the `FireflyError`/`PostingSplit` imports; made
  `OperationDeps.firefly` optional (unused). `GROUP_ROW_KEYS`/`mergeRows` (used by thingstore.update)
  kept.
- **`firefly.itest.ts` left as-is** (it validates the retained connector), rather than re-pointed —
  the dynamic ops are validated live via the vertical-slice hand-check and the e2e run in the stack
  window. `bookkeepingQuery.test.ts`'s connector-query test is likewise retained (connector kept).
- **Fixed a real bug found while re-pointing**: `host.run` read `context.idempotencyKey`
  unconditionally, but the inbound door calls client-readable ops with `NO_CONTEXT` (undefined) — it
  now reads `context?.idempotencyKey ?? ""`, so a dynamic clientReadable op does not crash on the door.
- **Inbound behavior change**: a dynamic Operation whose External System fails returns an error
  *outcome* (HTTP 200 `{ok:true, outcome:{kind:"error"}}`), where the old compiled op threw and the
  door answered 502. Still plainly distinct from a 403 refusal. `server.test` updated accordingly.

### Deployment assumptions
- **Bootstrap reads the seven Source files from `import/operations/bookkeeping/` at bootstrap time.**
  `just bootstrap` runs on the host from `runtime/` via tsx (`npm run bootstrap`), so
  `bookkeepingSeeds.ts` resolves `../../../import/operations/bookkeeping/` to the repo's `import/`
  correctly. This assumes bootstrap is run from the repo (the standard flow), not from a container
  whose image lacks `import/`. A containerized bootstrap would need `import/` mounted. The compiled
  worker path (`worker.js`) was verified present after a full `tsc` build, so the production runtime
  (which runs `node dist/src/index.js`) spawns the compiled worker, never the tsx branch.
- **Worker spawn across environments**: verified `worker.js` is emitted by `tsc`; dev/test use the
  tsx-register eval bootstrap; prod uses the compiled `worker.js`. tsx is a devDependency (pruned from
  the image), and the `.ts` branch never runs in prod because the code is `.js`.

## Adversarial review — findings and triage
An adversarial review of the whole change ran after code-completion. Outcome:
- **CRITICAL — postTransaction double-booking (my regression): FIXED.** My earlier scope-trim dropped
  `findSamePostingForThing`, but the seed's own description *promises* thingId dedup and two Turns/
  Conversations about one invoice each mint a different `external_id` (a supported case), so the code
  would have booked money twice. Restored `findSamePostingForThing` (search `tag_is:"thing:<id>"`,
  content-compare via `sameSplit`, not tag alone — one invoice may have up to four legitimate legs) in
  `postTransaction.ts`, with a new test. **This reverses the step-8 decision to drop it — that decision
  was wrong.**
- **HIGH — deleted-duplicate-hash recovery: FIXED.** Restored `duplicateHashVictim` + `transactionExists`
  + re-POST with `error_if_duplicate_hash:false` only when the named victim is confirmed gone, so a
  corrected (deleted) journal is re-bookable. New test covers both directions.
- **HIGH — `postsInFlight` single-flight: not restored (accepted).** The plan explicitly dropped it as a
  deliberate loss; the review agrees it is narrower (needs same-key concurrency, which the lease +
  single Runtime replica largely prevent). Covered by `external_id` + the two restored defenses.
- **MEDIUM — cache resurrection after a concurrent createAccount evict: accepted.** Bounded by the TTL,
  `createAccount` returns the account directly, and `resolveAccountId` force-refreshes on a miss, so a
  freshly created account stays resolvable. Noted rather than fixed (a tombstone would add complexity
  the impact doesn't justify).
- **MEDIUM — `clientExecutable` egress check: FIXED.** It now refuses an unconfigured egress, matching
  `grantedTo`, so the inbound door gives a clean refusal instead of a 502.
- **LOW — worker `terminate()` unhandled rejection: FIXED** (`.catch(()=>{})`). **LOW — synchronous spawn
  failure now becomes an error outcome: FIXED** (try/catch in `spawn`). **LOW — migration generator's
  dollar-quote escalation now progressive: FIXED.**
- **Accepted/noted (no change): compile cache is unbounded** (7 ops, trivial); **`loadConfig(env)`
  ignores its arg** (pre-existing pattern); **down-migration leaves orphan `Mutating`/`ClientReadable`
  flags** (harmless — a reverted built-in reads them from code).
- Review confirmed sound: http path/query encoding (no host/query smuggling), worker timeout bounds
  both sync and async hangs with no double-resolve, the two-source join's nine drop reasons, the
  migration's idempotency/atomicity and jsonb boolean mapping, no approval regression, TTL consistency.

After the fixes: **495 runtime tests pass, tsc clean.**

## Live verification on the REBUILT shared stack (2026-08-20)
User authorised taking over the shared stack; both client peers green-lit the build. Sequence run:
`just build` (exit 0) → `just up` (new images; server-init re-imported the additive `Operation_DM`
model **with no re-index restart loop** — step 3 verified) → applied
`import/migrations/2026-08-19-bookkeeping-operations-dynamic.sql`:
- `UPDATE 7`; re-run `UPDATE 0` (**idempotent**). All seven now `implementation: dynamic` with source
  (9.7k–18k chars each); `Mutating` true only on create/post; `ClientReadable` true only on
  listAccounts/listTransactions. **Step 9 installed-migration path verified.**
- Through the running compiled runtime's inbound door (the Dashboard's exact path): **`listAccounts`
  → 200** with the real Firefly chart of accounts; **`postTransaction` → 403 not-allowed** (mutating);
  **`getBalance` → 403** (not allowlisted). The dynamic op executes end-to-end through the compiled
  Operation Host worker against real Firefly, and the ADR-0023 gate holds for the dynamic path.
  **Step 10 core verified live.**
- Runtime is `assistants/runtime:0.1.0` (new image), healthy, logs clean (no ambiguous/unimplemented/
  uncompilable/egress drops).

**Browser e2e (2026-08-20, after the peer fixed the frontend):**
- **Dashboard** renders live with the dynamic ops: the Transactions tile (Payables → Expenses:Health
  96,50€ via dynamic `listTransactions`) and the Accounts tile (Checking 8.400,00€ via dynamic
  `listAccounts`) — the full browser → server → inbound door → Operation Host → real Firefly path.
- **Operations overview** shows the new `Implementation` and `Egress` columns; all seven bookkeeping
  ops read `dynamic` / `bookkeeping` (assistant.call = internal).
- **Operation form** renders the new fields (Implementation, Egress, Language=typescript, Timeout,
  Client readable) and the **Source textarea shows the stored TypeScript** ("// Bookkeeping egress —
  shared prelude (ADR-0025)…") — the User can read what a Bookkeeping Operation does, on the page.
- **Server re-index after the migration**: restarting the server re-indexed the migrated dynamic
  documents against the new model **cleanly — no restart loop, no validation failure** (the exact
  ADR-0019 risk, avoided). NOTE the operational ordering lesson: the direct-DB migration left the
  server's query index stale until a restart, so the overview showed blank Implementation until the
  server was restarted; the migration header's "run in the same maintenance window as the image swap"
  should be read as "and restart the server after applying it so it re-indexes."
- `just test-e2e` (Playwright, 59 tests): first run on `local_qwen` had 7 turn-dependent timeouts —
  the base e2e is designed for the deterministic `scripted` profile (replaying `llm-script.json`), and
  the stack was left on `local_qwen`, so fresh Documents couldn't get the expected Turn (confirmed:
  even in isolation the switch-off test timed out; runtime log showed ordinary LLM tool-call mistakes,
  none about dynamic ops). Switched `llm.json` to `scripted`, restarted the runtime, re-ran, and
  restored `local_qwen` afterward (I was authorised to restart the stack; llm.json verified clean after).
  **On `scripted`, THIS change's e2e is green** — `8-operations-catalogue` (incl. the Accountant
  reaching a dynamic bookkeeping op through the loop and getting the switched-off drop), `10-dashboard`,
  `3-crud`, navigation/forms/localization all pass. The **3 remaining failures are all in
  `9-conversation-transcript.spec.ts`** — the ui-changes peer's AssistantBadge/TranscriptHeader/ThingLink
  change (renders "🤖Accountant" where the un-updated spec expects the raw key; header-pin; about-link).
  Flagged to that peer; not this change.

**(Earlier) Blocked: browser e2e** — `assistants_frontend` crash-looped on a PEER's change (preview-the-attachment's
`/cs` proxy in `client/nginx.conf.template` references `${NGINX_ASSISTANTS_SERVER_CONTENTSTORE_URL}`,
which the frontend image's `envsubst` allowlist doesn't include → `nginx: [emerg] unknown variable`).
Not my change; pinged the peer (they asked to be). The backend is fully up and verified; the browser
CRUD/vertical-slice e2e waits on the frontend fix + a frontend rebuild.

## Final status — DONE

**Steps 1–11 complete; adversarial review run and its critical finding fixed; live-verified end to end
on the rebuilt shared stack.**

- **Static/unit/integration:** 494 runtime unit tests, 100 integration tests (incl.
  `dynamicBookkeeping.itest.ts` running the real Operation Host against live Firefly), `tsc` clean,
  `check-docs` clean (25 ADRs), model validation clean.
- **Docs:** ADR-0025 + ADR-0019 amendment; CONTEXT.md, domain.md, architecture.md, functional.md,
  README.md, DECISIONS.md (D-072/073/074).
- **Live on the rebuilt stack:** clean model re-import (no restart loop); migration `UPDATE 7`,
  idempotent; all seven ops `dynamic`/`bookkeeping` with source; server re-indexed cleanly; Dashboard
  tiles + Operations overview columns + Operation form Source field all render; ADR-0023 gate holds
  (listAccounts 200, postTransaction/getBalance 403); `test-e2e` green for this change on the intended
  `scripted` profile.

**Deviations from the plan, each recorded above with its reason:** (1) restored `findSamePostingForThing`
+ the deleted-duplicate-hash recovery in `postTransaction` — the plan/step-8 had dropped them and the
review proved that a money double-booking risk (this is the most important correction); (2) added a
third drop reason `unconfigured-egress`; (3) kept `FireflyConnector` (demo/cli.ts + health depend on
it) instead of stripping it — a clean follow-up; (4) dynamic Operations carry no `describeCall`, so
`postTransaction`'s approval prompt is the JSON fallback.

**Follow-ups worth a ticket:** strip `FireflyConnector` (rewrite `demo/cli.ts` off it first); consider a
synchronous `describe` for dynamic ops to restore the pretty approval prompt; the shared stack should
run `llm.json` on `scripted` for the base e2e (turn-dependent specs are non-deterministic on a live model).

**Not mine (flagged to peers, now resolved by them):** the frontend `/cs` envsubst crash
(preview-the-attachment — fixed); the 3 `9-conversation-transcript.spec.ts` e2e failures (ui-changes —
2 were spec-only, 1 was a real read-only-popup bug my run surfaced; all fixed in their working tree and
verified on `scripted`). NOTE: the deployed `:8081` frontend image was built with ui-changes' EARLIER
popup code, so it is now stale vs the working tree; the next `just build` of the frontend bundles their
fix. This does not affect this change's e2e (operations-catalogue/dashboard/crud don't touch the popup).

The change is not committed (this repo commits only on request); the working tree holds all of it plus
the two peers' concurrent work.
