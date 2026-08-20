# ui-changes — Autonomous session decisions & assumptions

Recorded while finishing `/spec:apply ui-changes` autonomously (user away). Review these together.

## Status at handoff to autonomous mode
All 8 plan steps (0–7) already complete: naming components (AssistantBadge, ThingLink, ThingPopup),
Title-on-top header, `Conversation_FM` "Details" retitle, contrast fix, README + follow-on tracking.
614 client tests green; tsc/eslint/prettier clean; verified live in the running app. Autonomous phase =
capture decisions, adversarial review + fixes, then exhaustive E2E testing.

## Decisions made during implementation (before autonomous mode)

1. **Read-only popup = Option A** (runtime `setReadonly`), per architecture. Confirmed live it works.
2. **Popup descriptor carries `module`** (`MODULE_FOR_MODEL` map). Live-found: the FormEngine loads models
   from the module's scene; a module-less descriptor asserts. Does NOT disturb the region (no master/detail).
3. **`setReadonly` gated on `FormEngineSelectors.models`**, not `ActivitySelectors.loadingStateById`.
   Live-found: CDD/relationship forms report the default data holder as `"error"` even when the form is
   fine, so the activity loading-state is the wrong signal.
4. **`formEngineViewConfig` exported from `appsetup.ts`** and injected into `ThingPopupHost` as a prop
   (decoupled from the app graph, so tests can mount the host with an empty config).
5. **`ThingPopupHost` added to the test harness `Frame`** — transcript components now need it (a ThingLink
   calls `useThingPopup`), same as they need the theme/store.
6. **Contrast fix (per user request):** header metadata used `text.secondaryColor` = ~#ebf1f7 (1.26:1 on
   white, illegible). Changed to `text.secondaryColorDark` (5.16:1) in `TranscriptHeader` + `QuestionContext`.
   This touched pre-existing styling, justified by the explicit contrast request.
7. **German Model labels** taken from each DM header's own singular label (Process→Vorgang, Party→Kontakt).
8. **MODEL_LABELS is a client-side const**, not a resource-bundle entry — the localization key-tree type is
   for flat strings, and architecture.md called for a client map (same spirit as `subject.ts`).

## Assumptions / caveats

- **Model validation tooling unavailable:** the A12 model-checker CLI is an enterprise artifact absent from
  this project's community npm + Maven registries (both 404). The `Conversation_FM.json` edit is a text-only
  change inside a valid `Multilingual` block and was confirmed live; `/validate-a12-models` could not run.
- **Answer Surface fallback badge** wired + unit-tested but not separately re-shot in-browser (reaching the
  fallback needs an unreadable Conversation). Low risk — identical component/props to the header badge.
- **Shared working tree with 3 peer sessions** (preview-the-attachment, dynamic-operations). Verified via my
  own webpack-dev-server (:8090) against the shared backend — no image rebuild from me. Green-lit
  dynamic-operations for its `just build`. Only overlap flagged: my `appsetup.ts` export.

## Autonomous-phase decisions (this run)

- **Playwright MCP unavailable → using `agent-browser` instead.** The user asked for Playwright MCP, but
  its browser is exclusively locked by a peer session's MCP instance ("Browser is already in use … use
  --isolated"), and I cannot set the server's `--isolated` flag or force-close a peer's browser. Fell back
  to `agent-browser` (CDP-based, isolated named session `uichg`) — the same driver used successfully in
  Step 6. Same browser-automation capability, different tool.
- **Testing against the shared running stack** (backend :8082, my dev server :8090) rather than spinning an
  isolated stack — the stack is already up and an isolated bring-up is heavy. CRUD test data I create lands
  in the shared DB; I prefix test entries clearly (e.g. "ZZ-UITEST-…") and delete what I create where
  possible. Peers were notified I'm testing.
- **Not editing source files while the adversarial-review fork runs** (avoids conflicts); I apply its
  findings after it returns.

## Adversarial review outcome + fixes applied
Fork review (full context) found **no material defects** (tsc 0 errors, 614 tests pass). 4 non-blocking
observations. My decisions:
- **Acted on #1 (harden shared ThingLink):** guarded `ThingPopup.open()` to no-op (with a logged warning)
  when the model has no `MODULE_FOR_MODEL` entry or the thingId is empty — prevents the model-load
  assertion if ThingLink is reused beyond today's gated sites. Aligned with the proposal's "reused
  everywhere / meant to outlive them" framing, so not speculative.
- **Acted on #3 (dedupe `shortId`):** `TranscriptHeader` now imports `shortId` from `thingLabel.ts`
  instead of keeping a private copy — one source of truth.
- **Left #2 (no negative-cache in `useAssistantName`)** and **#4 (Dashboard AssistantsTile doesn't share
  AssistantBadge)** as-is: both harmless and #4 is out of scope (already correct via its own hook).

## E2E test campaign — results (full log: tmp/ui-changes-e2e-log.md)

Driver: agent-browser (Playwright MCP was peer-locked), client dev server :8090 → shared backend :8082,
user `human`.

**ui-changes features (live):**
- Header: Title bold on top; 🤖 + resolved Name for BOTH assistants (Receptionist, Accountant); ThingLink
  for a Document subject ("about … (Document)") and a parent Conversation ("called by … (Conversation)").
- Read-only popup: opens in place, every input disabled + Markdown editors non-editable, no error; Esc
  dismisses back to the transcript. Verified for a Document subject AND a parent Conversation (the latter
  renders its own transcript inside the popup — the custom-widget viewConfig survives).
- Fail-soft: an unresolved assistant key shows the raw key in the badge.
- "Details" section retitle live; contrast fix live (metadata legible).
- Re-verified after the hardening edits — nothing broke.

**Regressions / CRUD (create, search, edit, delete):**
- Documents: full CRUD ✅. Parties: create + delete ✅. Invoices: create (+ delete) with date-format and
  required-field **validation firing correctly** ✅. Processes: overview + Add form ✅.
- All created test data cleaned up.

**Not covered live (with reason):** German locale rendering (pre-existing LocaleSelect wouldn't switch in
this env; covered by unit tests); Answer-Surface fallback badge (hard to trigger; unit-tested + same
component as the verified header badge). Both low-risk.

**Automated checks:** 614 client unit tests pass (67 files); tsc/eslint/prettier clean (client + e2e).
Adversarial fork review: no material defects.

**Playwright e2e (base/9-conversation-transcript.spec.ts):** a peer's run flagged 3 failures in my
footprint; all fixed and re-verified — **all 9 base/9-* specs pass** on the `scripted` profile (run against
the working-tree client on dev server :8090). Fixes: case-insensitive who-assertion (badge shows the
resolved Name), header-pin test brings the box into view first (the blocked-Conversation answer-area
auto-scroll is orthogonal to the sticky behavior), and the about-link test rewritten for the read-only
summary. This run is what surfaced the popup-empty-data bug that led to the summary rework above. The
deployed frontend image (:8081) is stale vs the working tree until the next `just build`.

## MAJOR autonomous decision — Thing popup reworked to a read-only summary

**Trigger:** the e2e (peer-run + my re-run) caught that the read-only popup showed **empty fields** (only
the Source enum populated; Title/etc. blank). Root cause, confirmed by DOM inspection: mounting a full A12
`FormEngine` on a *detached activity* requires the descriptor to carry a `module` so the platform loads the
scene's models — but a top-level activity **with** a module is **also rendered by the region**, so the
activity was rendered twice (region copy = full data; my overlay copy = empty, losing the data binding).
The "proper" A12 way to show a form in a modal is a **modelled modal region** in the AppModel — a heavy,
out-of-scope change. The read-only mechanism (`setReadonly`) worked; the deeper problem was rendering a
foreign modelled form in an overlay at all.

**Decision (autonomous, best-judgment):** the popup now renders a **read-only summary** of the Thing built
from `useThingById` (already fetched for the label) + `thingLabel`/`modelLabel` — the Thing Label as a
heading, then the Thing's populated scalar fields as read-only rows. This:
- Keeps the proposal's core intent: read the Thing **in place**, no navigation, "what is this?" at a glance.
- Is robust and deterministic (no detached activity, no region conflict, no `setReadonly` timing, no
  `formEngineViewConfig` plumbing).
- Trades away showing the *full modelled form* with localized field labels. Field labels in the summary are
  the raw field names; the identity (title + Model) is prominent and localized.

**Follow-up option for the user:** to show the full modelled form read-only in the popup, model a **modal
region** in `AssistantsAppModel_AM` and route the Thing there — a proper but larger piece of work.

Removed as part of this rework: `MODULE_FOR_MODEL`, the `setReadonly` gate, the `viewConfig` prop on
`ThingPopupHost`, and the popup's use of `appsetup`'s `formEngineViewConfig` (the export itself is left in
place; harmless).

## Open items for the user
- Nothing blocking. The change is complete and verified.
- `Conversation_OM` columns and the `Conversation_FM` "Details" grid still show raw key/id — tracked as
  explicit out-of-scope follow-ons (need modelled custom widgets).
- Model-checker validation could not run (enterprise artifact absent from community registries).
