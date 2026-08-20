# Plan — dynamic operations

Ordered so that the stack is runnable at the end of every step and the vertical slice never breaks
for longer than one step. Steps 1–6 add the machinery with nothing using it; step 7 is the switch;
steps 8–11 remove what it replaced and write it down.

Verification is named per step. `just test-runtime` is the unit suite, `just test-integration` needs
a live stack, `just check` is lint + typecheck + the docs check.

## 1 — Decide it in an ADR, before any code

- [x] Write `docs/adr/0025-a-dynamic-operation-carries-its-implementation.md`: what a Dynamic
      Operation is, why the Implementation may be data, and the sentence of ADR-0019 it amends —
      quoted, not paraphrased.
- [x] State the trust anchor explicitly: the protection was never that the code was compiled, it was
      that an Assistant cannot write `Operation_DM`. List the four store-side facts that make it so.
- [x] State the two things that genuinely weaken: `mutating`/`clientReadable` come from the Thing for
      a dynamic Operation, and the deployment allowlist is what carries the inbound gate. Say that
      the sandbox is containment and not a security boundary, in those words.
- [x] Record the considered options: mounted config files, hybrid file-seeded source, `node:vm` alone,
      a child process per call, precedence instead of ambiguity, a compiled per-system shim.
- [x] Add the amendment note to `docs/adr/0019-an-operation-is-a-thing.md` — its filename and title
      stay, per this repository's convention.
- [x] Bump the spelled-out ADR count in `README.md` from "twenty-four" to "twenty-five" (both
      occurrences). `check-docs.mjs` counts `docs/adr/*.md` and asserts the README's spelled number
      matches; adding ADR-0025 without this makes `just check` fail on this very step.
- [x] Verify: `just check` (the ADR-count check in `check-docs` must see 25, and the README must say
      "twenty-five").

## 2 — The domain words

- [x] Add **Built-in Operation**, **Dynamic Operation**, **Implementation Source**, **Operation
      Host**, **Egress** and **Result Contract** to `CONTEXT.md` under `### Systems`, with `_Avoid_`
      lines, from [domain.md](domain.md).
- [x] Amend the existing **Implementation** entry: never a Thing, but may be stored on one.
- [x] Amend **Connector**: what it still covers, and that Bookkeeping's translation is now the
      Operation Host plus its Source.
- [x] Verify: `just check`.

## 3 — `Operation_DM` and its form

- [x] Add `f_implementation` (string, 20), `f_source` (string, 65536), `f_language` (string, 20),
      `f_egress` (string, 40, indexed), `f_timeoutMs` (number) and `f_clientReadable` (boolean) to
      `import/models/operation/Operation_DM.json`. `f_clientReadable` is the one that is easy to
      forget and load-bearing: for a dynamic Operation the inbound gate reads `clientReadable` off
      the Thing (`f_mutating` already exists as the peer field; `clientReadable` has none today), and
      the two Dashboard reads stay reachable only because their seed sets it `true`.
- [x] Add them to `Operation_FM.json` — `source` as a multi-line text area sized for reading, the
      other five beside `mutating`. Every data model has a form model (ADR-0008).
- [x] Add `implementation` and `egress` as columns in `Operation_OM.json`, so the catalogue overview
      answers *which of these are dynamic* at a glance.
- [x] Extend the `Operation` interface in `runtime/src/domain/types.ts` with the six optional fields
      (`implementation`, `source`, `language`, `egress`, `timeoutMs`, `clientReadable`). Also mapped
      them in `runtime/src/a12/things.ts` and extended the `model-mapping` round-trip test.
- [x] Verify: `just test-models` **passed** (validate-models + A12 `convertModels`), runtime `tsc`
      clean, `model-mapping` round trip green. **`just build` + `just up` run on the real stack
      (2026-08-20): server-init re-imported the additive `Operation_DM` model with NO re-index restart
      loop — the server came up healthy on the new model.** The optional fields are the safe direction
      ADR-0019's amendment names, and the re-index of existing documents succeeded, as predicted.

## 4 — Compilation, test-first

- [x] `runtime/test/operations/dynamicCompile.test.ts`: TypeScript is stripped and evaluates;
      `import`, `export` and `require` are each refused with the token named; a syntax error reports
      the compiler's message; the cache returns the same module for the same source and a new one
      after an edit.
- [x] Confirm the tests fail.
- [x] Write `runtime/src/operations/dynamic/compile.ts` using
      `module.stripTypeScriptTypes(source, { mode: "transform" })` and `sha256` caching.
- [x] Verify: `just test-runtime`.

## 5 — The sandbox and the injected host

- [x] `runtime/test/operations/dynamicSandbox.test.ts`: `process`, `require`, `fetch` and `Buffer` are
      absent; an infinite loop is terminated at the timeout and the outcome is an error, not a hang;
      an over-allocation is terminated; `console.log` reaches the structured logger with the
      Operation's key; a returned value round-trips; a thrown `OperationError` becomes an `error`
      outcome with its message; any other throw becomes an `error` outcome whose message does **not**
      contain the stack, while the log does; `host.pending(...)` becomes a `pending` outcome.
- [x] `runtime/test/operations/dynamicHttp.test.ts` (against a local `node:http` fixture): the
      credential is attached and is unreadable from inside the sandbox; an absolute URL is refused; a
      path is joined and re-encoded so a `&` cannot steer the request; a query is built from an
      object; a 404 answers `{status: 404, ok: false}` and does not throw; a body over the cap is
      refused; an unknown egress name is refused with the name in the message.
- [x] Confirm they fail.
- [x] Write `dynamic/sandbox.ts`, `dynamic/http.ts`, `dynamic/worker.ts` and `dynamic/host.ts`
      (spawn, `workerData`, `resourceLimits`, `terminate()` on timeout, one message back).
- [x] Add `host.cache` — per egress, TTL'd, host-side — with tests that two executions share it, two
      egresses do not, an entry past `DYNAMIC_OPERATION_CACHE_TTL_MS` is a miss, and
      `host.cache.delete(key)` evicts. The delete is not optional: the old `accountCache` was
      process-lifetime and was cleared on `createAccount`; the TTL is a new staleness ceiling and
      `delete` is how `createAccount` keeps a freshly made account resolvable before the TTL lapses.
- [x] Add `DYNAMIC_OPERATION_TIMEOUT_MS`, `DYNAMIC_OPERATION_MAX_BODY_BYTES`,
      `DYNAMIC_OPERATION_MEMORY_MB`, `DYNAMIC_OPERATION_CACHE_TTL_MS` (default 300000) and the
      `EGRESS_<NAME>_URL` / `_TOKEN` / `_TOKEN_FILE` table to `config.ts`, with cases in
      `runtime/test/config.test.ts`. A Thing's `timeoutMs` may lower the ceiling and never raise it —
      test that.
- [x] Document the new variables in `.env.example`.
- [x] Verify: `just test-runtime`.

## 6 — The two-source join

- [x] Extend `runtime/test/registry.test.ts`: a dynamic Thing with source resolves and executes; one
      with `implementation: dynamic` and no source drops as `unimplemented`; one whose source does not
      compile drops as `uncompilable`; a key present in both code and source drops as `ambiguous`
      **in both directions**; unset `implementation` reads as `built-in`; a dynamic Thing naming an
      undefined egress is dropped with the egress named; `mutating` and `clientReadable` are read from
      the Thing for a dynamic Operation and from code for a built-in one; a `mutating` dynamic
      Operation with no `reconcile` resolves and is reported.
- [x] Confirm they fail.
- [x] Add `"ambiguous"` and `"uncompilable"` to `DroppedGrant["reason"]`, and make sure both reach the
      model, not only the log — the reason ADR-0019 gives for `disabled`.
- [x] Rework `OperationRegistry.resolve()` into the two-source join; keep the existing
      `requiresApproval` and prose behaviour byte-for-byte.
- [x] Verify: `just test-runtime`.

## 7 — The inbound gate

- [x] Extend `runtime/test/inbound/gate.test.ts`: a dynamic, allowlisted, `clientReadable`,
      non-mutating, unguarded Operation is allowed; the same one off the allowlist is refused; a
      dynamic Operation with `mutating: true` on the Thing is refused; a dynamic one with
      `clientReadable` unset is refused; built-in behaviour is unchanged in every existing case.
- [x] Confirm they fail.
- [x] Change `decide()` to take the resolved flags per Implementation kind — the allowlist check stays
      first and stays in configuration. Update the file's header comment, which currently states that
      two of the four checks come from code; for a dynamic Operation that is no longer true and the
      comment is load-bearing documentation.
- [x] Verify: `just test-runtime`.

## 8 — `bookkeeping.*` as Source

Written one Operation at a time, easiest first, each with a test before it.

- [x] Add `import/operations/bookkeeping/*.ts` and the shared prelude (account name → id, the
      `liabilities`/`liability` spelling, the Firefly field-name table, the transaction projection).
- [x] `getBalance` → source. Test through the Operation Host against an HTTP fixture.
- [x] `listAccounts` → source, with `host.cache` for the chart of accounts and the BUG-02 spelling
      case as an explicit test.
- [x] `listOpenItems` → source (depends on `listAccounts`' projection).
- [x] `listTransactions` → source, keeping the `ISO_DATE` refusal and the 200-row clamp, both tested.
- [x] `getBudgetReport` → source, keeping the mandatory period — without it Firefly reports
      `spent: null`, which reads as *nothing spent*.
- [x] `createAccount` → source, keeping search-then-create and its `reconcile`, and calling
      `host.cache.delete` on the chart-of-accounts key so the next `listAccounts` sees the new
      account — the behaviour the old `accountCache = undefined` gave for free. Test that a create
      followed by a list resolves the new account without waiting out the TTL.
- [x] `postTransaction` → source: splits validation, the currency guard, the 422 translation into the
      model's vocabulary, `external_id` from `host.context.idempotencyKey`, and a `reconcile` that
      calls `findByExternalId`. Test the approval path end to end — the first call refused and the
      question raised, the second call booking — and test that `reconcile` after an interrupted Turn
      finds the posting rather than booking it twice.
- [x] Record the deliberate loss: the `postsInFlight` single-flight map is gone, covered by
      `external_id` and the single Runtime replica. Note it in the ADR's consequences, not only here.
- [x] Verify: `just test-runtime`.

## 9 — Bootstrap and the switch

- [x] Extend `runtime/test/bootstrap.test.ts`: `implementation` is on the mirror side and is
      re-applied; `source`, `language`, `egress`, `timeoutMs` and `clientReadable` are created once
      and never re-applied; diverged source is reported by name and changed nowhere; a mirror that
      already matches does not move `updatedAt`.
- [x] Confirm they fail.
- [x] Extend `OperationImplementation["seed"]` so a seed can carry `implementation`, `source`,
      `language`, `egress`, `timeoutMs` and `clientReadable`, and load the seven Firefly Sources from
      `import/operations/bookkeeping/`. `listAccounts` and `listTransactions` seed
      `clientReadable: true`; the other five seed it unset (not client-readable).
- [x] Add `divergedSource` to `BootstrapReport` and report it in `bootstrap/cli.ts` beside
      `divergedDescriptions`.
- [x] Write `import/migrations/2026-08-19-bookkeeping-operations-dynamic.sql`: a single idempotent
      `UPDATE` (like `2026-08-13-assistant-tools-to-grants.sql`) that sets `implementation`, `source`,
      `language`, `egress`, `clientReadable` **and** `mutating` on the seven existing Operation Things
      — `clientReadable: true` only on `listAccounts`/`listTransactions`, `mutating: true` on
      `postTransaction`/`createAccount` — so an already-installed stack switches over without
      `just clean`, which would destroy the books. `mutating` and `clientReadable` are included
      because the registry and the gate begin **reading them off the Thing** for a dynamic Operation,
      and the values the Things carry from their built-in days were never authoritative and cannot be
      trusted.
- [x] Header comment on the migration, following the existing one's example: it is idempotent (the
      `WHERE` matches only Things not yet switched, so a second run is a no-op) and atomic (one
      `UPDATE`, so a failure at row 5 of 7 rolls the whole statement back — there is no half-migrated
      state to clean up; re-run it).
- [x] Run it **offline, in the same maintenance window as the image swap** — never against a live old
      Runtime. Either interleaving observed by a running Runtime strands the seven Operations: a
      migrated Thing (`implementation: dynamic`) meeting the still-compiled code drops as
      `ambiguous`, and the new image meeting an un-migrated Thing drops as `unimplemented`. With the
      Runtime down for the swap, neither window is ever live. State this order in the header.
- [x] Reversibility, stated in the header: rollback is **not** code-only. Restoring the previous image
      (compiled `bookkeeping.*` back) while the Things still read `implementation: dynamic` drops all
      seven as `ambiguous`. To roll back, restore the old image **and** revert the Thing fields
      (`implementation` to `built-in`, clear `source`) in the same offline window — ship the reverting
      `UPDATE` as a commented-out down-migration in the same file.
- [x] Delete the seven compiled `bookkeeping.*` Implementations from
      `runtime/src/operations/implementations.ts` and their construction in `services.ts`.
- [x] Verify: `just test-runtime` **passed** (494 tests after the review fix; the deletion's ripple
      across loop/operations/inbound tests was re-pointed — the harness now runs the dynamic ops through
      a Firefly HTTP fixture, and the pure-behavior duplicates moved to `dynamicBookkeeping.test.ts`).
      **Stack migration verified live (2026-08-20):** on the real stack with data, `just build` + `just
      up` (new image, no compiled bookkeeping) then applied the migration → `UPDATE 7`, re-run
      `UPDATE 0` (idempotent); all seven now `implementation: dynamic` with source, correct
      `Mutating`/`ClientReadable`; the runtime resolved them with **no `ambiguous`/`unimplemented`
      drops** and `listAccounts` returned the real chart through the door. The fresh-install seed path
      is covered by the `bootstrap.test.ts` dynamic-seed unit tests (create-once of source + the
      decision/mirror split).

## 10 — The live proof

- [~] Re-point `runtime/test/integration/firefly.itest.ts`: **not done — see DECISIONS-autonomous.md.**
      `FireflyConnector` was retained (demo/cli.ts + health depend on it), so its itest stays valid.
      Dynamic-op live validation is via the vertical slice + e2e below rather than a re-pointed itest.
- [x] ~~Strip `FireflyConnector`~~ **partially: the orphaned imports and types were removed from
      `implementations.ts`** (ISO_DATE, TRANSACTIONS_LIMIT_MAX, FIREFLY_FIELD_NAMES, describeRejection,
      projectTransactionGroup, describePosting, money, currentMonth; `FireflyError`/`PostingSplit`
      imports; `OperationDeps.firefly` made optional). The connector class itself was **kept**, not
      stripped — `demo/cli.ts` seeds the household through it and it is the health check. Stripping it
      (and rewriting the demo loader) is a recorded follow-up; no Operation calls it any more.
- [x] Verify: `just test-integration` — **DONE, green (100 tests).** Added
      `runtime/test/integration/dynamicBookkeeping.itest.ts`: the seven dynamic Operations run through
      the real Operation Host against the live Firefly (name→id resolution, BUG-02 spelling, ISO-date
      refusal, budget period, `external_id` idempotency + reconcile, account-invention refusal) — the
      "one layer out" proof, as an additive file (the retained connector's `firefly.itest.ts` still
      passes). No rebuild, no peer disruption. `bootstrap.itest.ts` re-pointed (VICTIM → `bank.sendMoney`).
- [~] Verify the vertical slice by hand on a live stack. **Dashboard-tile half done live**: both
      now-dynamic reads (`listAccounts`/`listTransactions`) answer through the inbound door on the
      rebuilt stack (see the ADR-0023 item), which is exactly what the Accounts/Transactions Tiles
      call. The **full invoice→Accountant→approval→Firefly slice** is pending the browser (the frontend
      was crash-looping on a peer's `/cs` change — peer is rebuilding it). The active LLM profile is
      `local_qwen`, so a real Accountant Turn may be exercisable once the browser is up. The dynamic-op *execution* the
      slice exercises is already proven live (the door + 100 integration tests + `postTransaction`
      approval/reconcile in `loop.test`).
- [x] Verify ADR-0023's property still holds **— done live (2026-08-20)** through the running compiled
      runtime's inbound door on the migrated catalogue: `bookkeeping.listAccounts` (dynamic,
      clientReadable, allowlisted) → 200 with the real Firefly chart; `bookkeeping.postTransaction`
      (mutating) → 403 not-allowed; `bookkeeping.getBalance` (not allowlisted) → 403 not-allowed. The
      gate reads the dynamic flags off the Thing exactly as designed. (No-bearer-401 and the
      transaction-count-invariant are the server's outer auth + the read-only nature of listAccounts,
      unchanged by this change.)
- [x] Verify: `just test-e2e` — **run on the rebuilt stack; this change's e2e is green.** On the base
      e2e's intended `scripted` profile: `8-operations-catalogue` (incl. "stop offering a switched-off
      Operation" — the Accountant reaching a now-dynamic bookkeeping op through the full loop),
      `10-dashboard`, `3-crud`, navigation/forms/localization/favicon all pass. The only remaining
      e2e failures are 3 in `9-conversation-transcript.spec.ts`, which belong to the concurrent
      ui-changes session (their AssistantBadge/TranscriptHeader/ThingLink change renders "🤖Accountant"
      where the un-updated spec expects the raw key, plus header-pin/about-link) — not this change;
      flagged to that peer. (The first full run showed 7 turn-dependent timeouts because the stack was
      left on `local_qwen`, not `scripted` — a config mismatch, not a regression; switching to the
      intended profile resolved all four of this change's turn-dependent tests.)

## 11 — Write it down

- [x] `specs/system/domain.md`: the Built-in / Dynamic split and the new terms.
- [x] `specs/system/architecture.md`: the Operation Host, the egress table, and — since the Operations
      table was already removed — the built-in/dynamic distinction in the `#### Operations` prose plus
      a new `#### The Operation Host` subsection.
- [x] `specs/system/functional.md`: what the User can now do that they could not — read and edit what
      a Bookkeeping Operation does.
- [x] `README.md`: the Implementations paragraph, the catalogue diagram's Firefly box, and the
      "replacing the ledger is a Connector rewrite" bullet, which now names editing stored source.
- [x] `DECISIONS.md`: D-072 (source on the Thing over mounted files), D-073 (worker plus `vm` over
      either alone), D-074 (ambiguity refused over precedence) — each with its alternative and reversal
      cost, appended after the peer's D-071.
- [x] Verify: `check-docs` green (25 ADRs, 28 recipes), runtime `tsc` clean, `just test-runtime` green
      (493). `just check`'s client/e2e lint fails only on the concurrent peer sessions' in-progress
      client work, not this change; the full `just test` (integration + e2e) is **deferred to the
      shared-stack window** with the other live checks.
