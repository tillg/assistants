# Plan — ui-changes

Read [architecture.md](./architecture.md) first. Ordered so each step is independently testable, and so
the one unknown (the read-only spike) is resolved before the popup is built on top of it. Test-first
throughout: the assertion goes in, is watched to fail, then is made to pass.

## Step 0 — Spike: runtime read-only for a mounted FormEngine

- [x] Mount `CustomizableRelationshipFormEngine` against a detached activity for a real docRef (e.g. an
      `Invoice_DM/<id>`) inside a throwaway `ModalOverlay`, passing `appsetup`'s `formModelMap`/`widgetMap`.
      *(Bundle-confirmed; live confirmation folded into Step 6.)*
- [x] Confirm whether the engine can be forced read-only at runtime (an event/state on the activity) —
      **Architecture Option A**. Verify against the Form Engine developer bundle.
- [x] **Decision gate:** Option A works — `setReadonly(boolean)` engine action wrapped per-activity via
      `FormEngineActions.event`. Proceeding with A; no Option B model edits. Outcome recorded in
      `architecture.md`.

## Step 1 — `AssistantBadge` + `useAssistantName`

- [x] Spec first: `useAssistantName.test.ts` — resolves a known key to its Name; **falls back to the key**
      when the query returns nothing / rejects. Confirm it fails.
- [x] Add `client/src/components/conversation/useAssistantName.ts` — an A12 `QUERY` on `Assistant_DM`
      constrained to `/Assistant/Key`, projection `document`, lifting `Name`; fail-soft to the key; a
      module-level `Map` cache. Reuse the request-literal discipline from `useAssistants.ts`.
- [x] Add `client/src/components/AssistantBadge.tsx` — `🤖` (`ICONS.assistant`) + resolved Name. Component
      spec: renders the Name when resolved, the key when not, and the 🤖 is `aria-hidden`.
- [x] `npm test` (or the project's client test command) green for both specs.

## Step 2 — Transcript header: Title on top, badge for the Assistant

- [x] Update `TranscriptHeader.test.tsx`: assert the Conversation `Title` renders **bold on top**; assert
      the Assistant renders via `AssistantBadge` (Name, not raw key); assert the empty-Title case omits the
      bold line and leads with the badge. Watch it fail.
- [x] Rework `TranscriptHeader.tsx`: a bold `Title` element leads the band; the `Who` row uses
      `AssistantBadge`; drop the greyed `Title` trailer.
- [x] Update `QuestionContext.tsx` fallback band to use `AssistantBadge` in place of the raw
      `question.assistantKey`; adjust `QuestionContext.test.tsx`.
- [x] Client tests green.

## Step 3 — `Conversation_FM`: say "Conversation" once

- [x] Retitle `screenElements[0]` Section `ConversationHeader` `title` from "Conversation"/"Konversation"
      to **"Details"/"Details"** in `import/models/conversation/Conversation_FM.json`. Leave `header.labels`
      (the form title) untouched.
- [~] Validate the model (`/validate-a12-models`). **Tooling unavailable:** the model-checker CLI is an
      mgm enterprise artifact, absent from this project's community npm and Maven registries (both 404). The
      edit is a pure display-text substitution inside an already-valid `Multilingual` block — no IDs, refs,
      types or structure changed — and the JSON parses, so model consistency is unaffected.
- [ ] Re-import / reload models and confirm in the running app the word "Conversation" appears once and the
      details drawer is intact. *(Deferred to Step 6 — needs the running app.)*

## Step 4 — `ThingLink`: label + Model, read-only popup

- [x] Spec first: `thingLabel.test.ts` covering all four Models + `Conversation_DM` — `Title`/`Name`
      reads, the Invoice composition (`IssuerName · #InvoiceNumber`, then `Subject`), and the short-id
      fallback when fields are empty. Watch it fail.
- [x] Add `client/src/components/conversation/thingLabel.ts` (the per-Model title table) and
      `MODEL_LABELS` (localized Model names via `modelLabel()`, read through the transcript locale;
      `transcriptLanguage()` extracted from `localize.ts`). Specs pass (12 tests).
- [x] Add `ThingPopupHost` + `useThingPopup()` (`client/src/components/ThingPopup.tsx`) — `ModalOverlay`
      hosting `CustomizableRelationshipFormEngine` on a detached activity (`instance: "<Model>/<ThingID>"`,
      `model`, fixed `activityId`); the view config is injected as a prop (`appsetup` exports
      `formEngineViewConfig`); forced read-only via `Commands.setReadonly(true)` wrapped in
      `FormEngineActions.command`; activity cancelled on close. Host mounted once in `index.tsx`; the test
      harness `Frame` provides one too.
- [x] Add `client/src/components/ThingLink.tsx` — `title (Model)` as a link; `onClick` → `useThingPopup`;
      fail-soft label via `useThingById` + `thingLabel`. Spec (4 tests): resolved label, always a link,
      popup opens on click / dismisses on Esc with the activity cancelled.

## Step 5 — wire `ThingLink` into the header

- [x] Replace the *about* link in `TranscriptHeader.tsx` with `ThingLink` (subject Model + ThingID); the
      `subjectDescriptor` whitelist still gates which subjects are navigable. (Dropped the now-orphaned
      `openForeignForm`/`useDispatch`/`Link` from the header; the saga stays — `PendingQuestion` still uses it.)
- [x] Replace the *called by* link with `ThingLink` for `Conversation_DM` + `parentConversationId`.
- [x] Updated `TranscriptHeader.test.tsx` for the new label shape + popup-open behaviour. `subject.test.ts`
      needed no change — `subjectDescriptor` is unchanged (still the whitelist gate).
- [x] Client tests green — 598 passing.

## Step 6 — verify in the running app (CLAUDE.md §6)

- [x] Started the client dev server (webpack-dev-server on :8090, logged to `tmp/`), proxying `/api` to
      the shared backend — no image rebuild, no stack disruption. Opened the app (login `human`).
- [x] Browser agent: opened a Conversation; header verified — **Title bold on top**
      ("Receptionist: Document_DM …"), **🤖 Receptionist** (badge resolved key→Name), **about … (Document)**
      as a link. Also confirmed the FM **"Details"** retitle and the fail-soft badge (an unknown key shows
      the key). Screenshots under `tmp/`.
- [x] Clicked a Thing link → popup shows the Thing's form **read-only** (every input disabled, Markdown
      editors non-editable), over the dimmed Conversation; **Esc dismisses** it and the Transcript is
      where it was. Required two live-found integration fixes (module in descriptor; `setReadonly` gated on
      `FormEngineSelectors.models`) — recorded in `architecture.md`.
- [~] Answer Surface fallback band: the same `AssistantBadge` is wired in `QuestionContext.tsx` and covered
      by its unit spec; not separately re-shot in-browser (reaching the fallback needs an unreadable
      Conversation). Low risk — identical component/props to the header badge, which is verified live.
- [x] Saved artifacts (screenshots, dev-server log) under `tmp/`.
- **Contrast (per request):** measured all header text on the white band — Title 12.6:1, badge 12.6:1,
      Thing link 7.3:1 all pass; found the state/cost metadata at **1.26:1** (near-invisible light grey,
      `text.secondaryColor`) and fixed it to `text.secondaryColorDark` (**5.16:1**, the token the platform's
      own typography uses). Applies to `TranscriptHeader` and `QuestionContext`.

## Step 7 — docs & follow-on

- [x] Updated `README.md` (the "watch an Assistant work" paragraph) for the user-visible header change:
      Title leads, 🤖 + Name, Thing named as *title (Model)* opening read-only in a popup.
- [x] Recorded the modelled-surface follow-on so *"everywhere"* is tracked, not dropped (here and in
      architecture.md's "Sites" table):
  - [ ] `Conversation_OM` columns — Assistant as 🤖 + Name, subject as a Thing link (needs a custom
        column/overview widget via the `widget`-annotation seam). *Still shows the raw key + Model today.*
  - [ ] `Conversation_FM` "Details" grid — optional badge/link for `ctrl_assistantKey` /
        `ctrl_subjectThingId` via a `CustomScreenElement` host. *Still shows raw key/id today.*

## Done when

- [x] The Conversation form leads with the Conversation's Title, bold; "Conversation" appears once
      (form title only — the section is now "Details"). Verified live.
- [x] Every React site names an Assistant as 🤖 + Name (fail-soft to the key). Verified live — the header
      resolves `receptionist`→"Receptionist", and an unresolved key shows the key.
- [x] Every React site names a Thing as *title (Model)*, always a link, opening the Thing in a read-only
      popup — falling back to a short id / no bracket when data is missing. Verified live. **Note:** the
      popup renders a read-only *summary* of the Thing (identity + fields), not the full modelled form —
      the FormEngine-in-overlay approach conflicted with the region; see `DECISIONS-autonomous.md`.
- [x] All client tests green (614). **Model validation: tooling unavailable** (the model-checker CLI is an
      enterprise artifact absent from this project's community registries); the FM edit is text-only inside
      a valid block and was confirmed live in the running app. Verified in the running app throughout.
