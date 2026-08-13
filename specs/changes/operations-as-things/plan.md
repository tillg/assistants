# Plan

Ordered so that each phase leaves the suite green. Read [architecture.md](architecture.md) first —
every step below assumes the three types and the resolution rules it defines.

Test-first throughout: the failing test comes before the code that satisfies it, and no phase is
finished until its tier passes.

## A — The Model

- [x] Create `import/models/operation/Operation_DM.json`. Root group `Operation`, header
  `roles: "user,runtime"`, `modelVersion` per CONVENTIONS.md's per-type table. Fields in the order
  given in architecture.md's table, the four machine fields last. **No `Implementation` field.**
- [x] `Key`, `System` and `Kind` carry the `indexed` annotation — as a **sibling** of the
  `"Field"` payload, not inside it. **`Enabled` does not**: it is a `BooleanType`, and
  `validate-models.mjs` refuses `indexed` on one because A12 can filter only `StringType` and
  `DateTimeType`. `Assistant_DM.f_enabled` is unindexed for the same reason.
- [x] `System` and `Kind` carry `hintList`s, one entry per locale with the same ASCII values, so the
  form gives a picker without becoming an Enum the index would localise. `System` includes `Runtime`,
  which is a legitimate System in the catalogue even though it is not an External System.
- [x] `Description`, `Parameters` and `Notes` are `StringType` with `lineBreaksPermitted` **and**
  `noValueValidation` — prose and JSON both need the first, and the second exempts them from the
  BMP character check.
- [x] Create `Operation_FM.json`: direct binding, `Description` and `Notes` as `exposition: "AREA"`,
  each `elementRef` at most once. `Mutating` sits beside `RequiresApproval`; `Parameters` goes last
  and read-only.
- [x] Create `Operation_OM.json`: columns `Key`, `System`, `Kind`, `Enabled`, `RequiresApproval`,
  `Mutating`.
- [x] Add the Operation pair to `import/models/AssistantsAppModel_AM.json`, beside the Assistant pair.
- [x] `node import/validate-models.mjs` — green, and the model count it reports goes from 26 to 29.
- [x] `just build && just up` so the new models reach `build/wcf-output/data/models` and the server
  imports them; confirm the form opens in the web application with no data in it yet.

## B — The rename

Atomic, and before any new code leans on either vocabulary. A half-rename is what makes someone ask
*"so what is the difference between a Tool and an Operation?"* again in six months.

- [x] `Assistant_DM.json`: group `f_tools`/`Tools` → `f_grants`/`Grants`, field
  `f_tool_operation`/`ToolOperation` → `f_operation_key`/`OperationKey`. Leave `repeatability: 60`
  intact; the locale labels read *Operation* / *Operation*, because the column holds one.
- [x] `Assistant_FM.json`: `section_tools`/`SectionTools` → `section_grants`/`SectionGrants`, title
  *Tools* / *Werkzeuge* → *Granted operations* / *Erteilte Operationen*, `inlinerepeat_tools` →
  `inlinerepeat_grants`, `repeatcolumn_tool_operation` → `repeatcolumn_operation_key`, and its
  `elementRef` to the DM's new field id. **The `elementRef` must match the DM id exactly** or the
  form's repeat renders empty.
- [x] `node import/validate-models.mjs` — the FM/OM cross-checks are what catch a missed `elementRef`.
- [x] Rename in `runtime/src/`: `ToolDefinition` → `GrantedOperation`, `ToolRegistry` →
  `OperationRegistry`, `ToolContext`/`ToolOutcome` → `OperationContext`/`OperationOutcome`,
  `ToolDeps` → `OperationDeps`, `interface ToolGrant` → `Grant` (its field `operation` →
  `operationKey`), `Assistant.tools` → `Assistant.grants`, `SPECS.Assistant_DM`'s `tools` group →
  `grants`.
- [x] Move `runtime/src/tools/tools.ts` → `runtime/src/operations/implementations.ts` and
  `runtime/src/tools/registry.ts` → `runtime/src/operations/registry.ts`.
- [x] `AssistantSeed.tools` → `grants` in `runtime/src/bootstrap/assistants.ts`, and the field written
  in `bootstrap()`.
- [x] Leave alone, and grep to confirm nothing renamed them by accident: `ToolSchema`,
  `toolNameForLlm`, `operationFromLlm`, `response.toolCalls`, `role: "tool"`, the `tool-intent` /
  `tool-result` Entry kinds, and `Entry.toolName` / `toolArgs` / `toolResult`. The last two groups are
  **stored data** — renaming them makes every existing Conversation unreadable to `buildMessages`.
  `runtime/fixtures/llm-script.json` uses the wire spelling and needs no change.
- [x] `just test-runtime` — green on the rename alone, before any behaviour changes.
- [x] `just build && just up && just bootstrap`, then open an Assistant in the web application and
  confirm the granted Operations are listed under the renamed section. Until bootstrap runs, the
  stored `Tools` group is unreadable and grants are empty — the expected, recoverable state described
  in [architecture.md](architecture.md), not a bug to chase.

## C — Types and the repository

- [ ] Add `"Operation_DM"` to `ThingModel` in `runtime/src/domain/types.ts` and the `Operation`
  interface (fields per architecture.md — no `implementation`).
- [ ] Leave `TRIGGER_ELIGIBLE_MODELS` alone, and add a sentence to its comment saying `Operation_DM`
  is excluded for the same structural reason as `Assistant_DM` — so the next reader does not "fix" it.
- [ ] Add `SPECS.Operation_DM` in `runtime/src/a12/things.ts`, machine fields spread last.
- [ ] Test: a round trip through `toDocument` / `fromDocument` preserves every field, including a
  `Parameters` string containing newlines and braces.

## D — The Implementation / Operation split

- [ ] Write the failing tests first, in `runtime/test/registry.test.ts` against a hand-built
  catalogue fixture:
  - a grant naming an Operation that is not in the catalogue → not offered, dropped as `absent`,
    naming the Assistant and the key;
  - `enabled: false` → not offered, dropped as `disabled`;
  - no Implementation registered under the key → not offered, dropped as `unimplemented`;
  - `Parameters` that is not valid JSON → not offered, dropped as `unparseable`, with the parse error;
  - `description` and `parameters` in the offered schema come **from the Thing**, not from the seed;
  - `requiresApproval: true` on the Thing over a seed that omits it → the resolved
    `GrantedOperation` requires an approval;
  - `requiresApproval: false` on the Thing over a seed that sets it → **permitted**, and a warning is
    logged naming the Operation — **once**, not once per resolution;
  - `mutating` comes from the Implementation even when the Thing says the opposite;
  - unchanged behaviour: a bare `assistant.call` is not a wildcard, a self-call is refused, duplicate
    grants collapse, `calleesOf` is untouched.
- [ ] Add `OperationImplementation` and `DroppedGrant` to `runtime/src/operations/registry.ts` and
  change `register` / `registerAll` to take Implementations.
- [ ] Change `grantedTo(assistant, catalogue)` to return `{ granted, dropped }` and
  `schemasFor(assistant, catalogue)` to resolve against the snapshot. Keep the `GrantedOperation`
  **shape** exactly as it is — it was renamed in B and must not also change field for field, or
  `advance()` stops being a near-no-op in this change.
- [ ] Convert all seventeen definitions in `runtime/src/operations/implementations.ts` to
  Implementations: `execute`, `reconcile`, `describeCall` and `mutating` stay where they are;
  `description`, `parameters` and `requiresApproval` move into `seed`, along with the new `name`,
  `system` and `kind`. `manualConnector` produces `kind: "manual-connector"` and keeps appending
  *"This is performed by the User by hand"* to the seeded description.
- [ ] Confirm `WRITABLE_MODELS` still excludes `Operation_DM`, and add a test that
  `thingstore.update` on it is refused with a message naming the allowed Models.
- [ ] **Make `READABLE_MODELS` real.** It is declared at today's `tools.ts:254` and referenced
  nowhere. Define it as `Object.keys(SPECS)` minus `Operation_DM`, enforce it in `thingstore.get` and
  `thingstore.search` exactly as `WRITABLE_MODELS` is enforced in `create` / `update`, and delete the
  doc comment that claimed a guard that did not exist. Tests: `Operation_DM` is refused with a message
  naming what may be read; every other Model still reads.
- [ ] `just test-runtime` — green.

## E — The Turn loads a catalogue

- [ ] Failing test: `advance()` throws before the provider is called when the catalogue is empty, and
  the Conversation's `turnCount` is unchanged.
- [ ] Add a catalogue read at the top of `LoopDriver.advance()` — one unconstrained
  `things.search(SPECS.Operation_DM)` — and thread the snapshot to `callLlmWithRetries`, the tool-call
  loop and `reconcile()`.
- [ ] Refuse an empty catalogue with a message that says bootstrap has not run, and log it at error.
- [ ] **The belt message consults `dropped`.** At `advance.ts:575`, a call that resolves to nothing is
  answered with the true reason — *"`bank.sendMoney` is switched off"*, *"…is no longer
  implemented"*, *"…is not granted to you"* — instead of *"is not one of your tools"*, which is false
  whenever the grant is still in the Assistant's definition. Test each reason's wording.
- [ ] **The startup check** in the watcher: before the first scan, read the catalogue; if it is empty
  or unreadable, log at error with the remedy, do not scan, and report unhealthy. Re-check on every
  scan, and log the transition — *"catalogue found: 17 Operations; scanning resumed"* — when one
  appears. Tests: no scan while empty; scanning resumes without a restart; the transition is logged
  once, not per scan.
- [ ] Give `runtime/test/support/harness.ts` a default catalogue derived from the registered
  Implementations' seeds, so existing tests keep working with one call-signature change each.
- [ ] Update the call sites in `runtime/test/loop.test.ts` (`schemasFor`, `grantedTo`, `calleesOf`).
- [ ] Test: an Operation switched off under a **suspended** Conversation. The Open Question is
  answered, the Conversation resumes, the model takes a fresh Turn and is told the Operation is
  switched off. This is **not** the reconciliation path — a suspended call already has a `pending`
  tool-result, so `unresolvedIntent` never finds it — and the test must assert the message, not just
  that nothing was stranded.
- [ ] Test: an Operation switched off under a Conversation that **crashed** mid-call still reaches
  `reconcile()`'s *"no longer available"* settlement, unchanged.
- [ ] Test: the effective `requiresApproval` from the Thing gates `bookkeeping.postTransaction`
  end-to-end within the unit tier — the existing approval tests keep passing with the flag arriving
  from data instead of code.
- [ ] `just test-runtime` — green, including every test that existed before this change.

## F — Bootstrap

- [ ] Failing integration test in `runtime/test/integration/`: bootstrap creates one Operation per
  Implementation; a second run with a changed seed `system` updates the Thing; a second run with a
  changed seed **description** leaves the Thing alone **and reports it**; a second run leaves an
  `enabled: false` and a hand-set `requiresApproval` untouched.
- [ ] Add the Operation loop to `bootstrap()`, **before** the Assistant loop, keyed
  `operation:<key>`. On create, every seeded field plus `enabled: true`. On update, only the
  mechanical mirror: `system`, `kind`, `parameters`, `mutating`.
- [ ] Collect the Operations whose stored `description` differs from their seed and report them by
  name, changing nothing.
- [ ] Extend the returned counts and the CLI's report with the Operation totals and the divergence
  list.
- [ ] Rewrite the doc comment on `bootstrap()`: it now has three behaviours, not two, and the third
  one — re-apply what the code knows, never re-apply a decision — is the one a reader will not guess.
  Say explicitly that the prose is on the decision side of that line.
- [ ] `just bootstrap` against the live stack, then read the catalogue in the web application: all
  seventeen present, descriptions rendering as markdown, `bookkeeping.createAccount` there.

## G — Security

- [ ] Add `Operation_DM` to the model set in the *"User Has ASSISTANT_WRITE Right For An Assistant"*
  rule in `import/auth/childAuthorizationDefinition.json` — **all three resource shapes**: the bare
  model-name string, the `DocumentV2`, and both sides of the `DocumentUpdateResource`.
- [ ] Rename that policy and the *"Assistant Write Permission"* to name what they guard now (the
  system's own definition), and extend both descriptions.
- [ ] Update the `ASSISTANT_WRITE` comments in `import/auth/roles.yaml`: the right now covers
  `Assistant_DM` and `Operation_DM`, and the name is narrower than the job.
- [ ] Restart the stack (or reload the rules with `RELOAD_AUTH_RULES`) and confirm the definitions
  are actually in force before writing the test — an auth change that did not load is a test that
  passes for the wrong reason.
- [ ] **The load-bearing test**: an integration test authenticating as the `runtime` identity, calling
  `MODIFY_DOCUMENT` on an existing Operation Thing, asserting `-32059`; and the same call as the
  `human` identity succeeding. Add the mirror for `ADD_DOCUMENT`.
- [ ] Test that the Runtime can still **read** `Operation_DM` as `runtime` — the guard must withhold
  writes without breaking the hot path. Note that this is the store's read right, which is a different
  thing from `READABLE_MODELS`: the latter governs what an *Assistant* may ask for through
  `thingstore.get` / `.search`, and it excludes `Operation_DM` while the Runtime's own read does not.
- [ ] `just test-integration` — green.

## H — The web application

- [ ] Confirm the Operations overview lists the catalogue and the form opens; check that the
  code-owned fields render read-only, `Description` renders as markdown, and `Parameters` is last.
- [ ] e2e: switch an Operation off in the UI, advance a Conversation, and assert the Assistant is no
  longer offered it. Save artefacts under `tmp/`.
- [ ] `just test-e2e` — green.

## I — Documents

Written during the grilling session that settled this change; this phase is verification that they
match what was built.

- [x] **ADR-0019 — "An Operation is a Thing."** Carries four arguments: why the catalogue belongs in
  the store (ADR-0003's argument applied a second time), why the Implementation cannot be data, why
  the grant stays a key rather than a reference, and why write access is the mitigation. Honest about
  the ADR-0018 consequence.
- [x] **ADR-0020 — ""Tool" is the provider's word."** The vocabulary decision, split out because its
  rationale is cited far more often than the catalogue's and would be invisible as argument five of
  five. Carries the rejected pairs (`Tool`/`AllowedTool`, `Operation`/`AllowedOperation`).
- [x] **The amendment note on ADR-0018**, dated, at the foot of the file, recording that
  `requiresApproval` is now data the User owns in both directions. Its body is left as written
  history. This sets the repo's convention for amending an ADR.
- [x] **The note on ADR-0010**, one line, keeping its filename and title — it is cited from six files —
  and recording that what it calls a Tool is now a Granted Operation and that its rule is a
  conjunction.
- [x] **`CONTEXT.md`**: **Operation** redefined (a capability one System offers — external, internal
  or the Runtime — and a Thing) and marked with the LLM-API caveat; **Implementation** added;
  **grant** added; **Tool** replaced by **Granted Operation**; **Approval** amended with the User's
  ownership; **Assistant**'s *"set of Tools it may use"* → *"the Operations it is granted"*;
  **Runtime** noting the one Operation it offers; **Conversation**'s *"a called tool"* →
  *"an Operation it called"*; **Pending Tool Call** keeping its name, with the reason.
- [ ] `specs/system/domain.md`: nine Models not eight, `Operation` in the Models table, the
  single-writer table, ADR-0010's rule as a conjunction, the vocabulary table's **Tool** row →
  **Granted Operation**, and the known departures from this change's [domain.md](domain.md).
- [ ] `specs/system/architecture.md`: the Operations table becomes a pointer at the catalogue plus the
  grant matrix; the `#### Tools` section is retitled `#### Operations` and gains the split and the
  per-Turn snapshot; the Models paragraph's counts are corrected — and note while there that its
  *"seven `_OM`s"* is already wrong (there are eight before this change, nine after); the roles table
  and the D-007a bullet gain `Operation_DM`.
- [ ] `specs/system/functional.md`: a feature section for reading and editing the catalogue; the
  permissions table gains a `Write Operation` row; the edge-cases list notes that switching an
  Operation off is not retroactive for a Conversation already waiting on it.
- [ ] `import/models/CONVENTIONS.md`: `Operation` into the who-writes-what table.
- [ ] `README.md`: the recipe table and the model list where they name counts; one paragraph on the
  catalogue as the answer to *"what can my Assistants actually do?"*; and three entries under
  *Status and limitations* — the catalogue does not say where an Operation's code lives, Operations
  cannot be added dynamically, and the read guard covers one Model only.
- [ ] `specs/research/ASSISTANTS_VS_OPENCLAW.md`: nothing to mark built — this change is not on the
  learnings list — but check learning 17's wording still reads correctly now that a catalogue exists,
  since the distinction between *describing* an Operation and *inventing* one is what keeps it a
  rejection.

## J — Verification

- [ ] `just check`.
- [ ] `grep -rin "tool" runtime/src import specs/system CONTEXT.md README.md` and account for **every**
  remaining hit: it must be the provider boundary, stored data, or an ADR's decided history. Anything
  else is the half-rename this change exists to prevent.
- [ ] `just test` with the stack up: models, runtime units, integration, client, e2e. Record the
  counts in the closing notes, as the previous change did.
- [ ] Read the catalogue one last time as the User would, and confirm the four questions it exists to
  answer are answerable without opening an editor: what can this Operation do, which System does it
  touch, does it need my approval, and is it on?

## Noticed, and deliberately not fixed here

- `registry.ts`'s header comment claims the idempotency contract is enforced — *"`mutating: true`
  without a key argument is a programming error and throws at registration"* — and `register()`
  performs no such check. Pre-existing, unrelated to this change, and worth its own commit rather than
  a drive-by inside a rename.
