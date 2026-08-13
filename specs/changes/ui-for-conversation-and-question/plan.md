# Plan

Ordered so that each phase leaves the suite green and the application usable. Read
[architecture.md](architecture.md) first — every step assumes the four seams it names and the
Speaker table in [domain.md](domain.md).

Test-first throughout: the failing test comes before the code that satisfies it. For the things no test
can settle, phase A settles them by trying, before anything is built on top: whether a custom screen
element renders at all, whether a header pins inside one, whether a non-BMP glyph survives a model file,
and what shape the store actually puts in an activity descriptor. **Cross-module navigation is not among
them** — [architecture.md](architecture.md)'s seam 2b settles that from source, and phase D proves the
built article against the action sequence recorded there.

New user-visible strings are **English literals in the components**: this change registers no
localisation key, because the application's localisation is being removed in a separate change (see
[proposal.md](proposal.md)).

Commands are `just` recipes: `just test-models`, `just test-client`, `just test-e2e`, `just test`.

## A — Settle the unknowns before building on them

- [ ] **Spike the custom screen element.** Add a throwaway `CustomScreenElement` to
  `Conversation_FM` (`name: "Spike"`, annotation `widget: conversation-transcript`), register a
  `formModelMap.CustomScreenElement` component in `appsetup.ts` that renders one line of text, and open
  the Conversation form in the browser. Verify: the line appears where the element sits, and
  `props.config.renderOptions.state.data.document` contains the Conversation with its `Entries`.
  Screenshot into `tmp/`.
- [ ] **Spike the pinned header.** Extend that same throwaway element into a `height`-bounded box with
  `overflow-y: auto`, a `position: sticky` band at its top and a hundred filler rows beneath it. Scroll
  to the bottom. Verify: the band is still on screen, the form's own scrollbar has not been displaced,
  and the box behaves on a narrow viewport. Screenshot the scrolled state into `tmp/`. This is the one
  step that decides whether the Header design holds — if sticky will not stick inside the form engine's
  container, say so here and fall back to a header that scrolls with the thread before phase C builds
  on it.
- [ ] **Spike the 🛑 in a model file.** Add the `ExpressionColumn` to `Conversation_OM` with the emoji
  in its expression, run `just test-models` **and** the A12 model checker
  (`/validate-a12-models`), and look at the rendered overview. Verify: no model error, and the glyph
  appears for a Conversation with `waitingFor = user` and not for others.
  - [ ] Record the working expression **verbatim** in `architecture.md`'s seam 3. No artifact currently
    contains the string an implementer would paste, only its semantics — and phase E depends on it.
  - [ ] If the model checker rejects the glyph, or it renders as a replacement character, fall back to
    an expression rendering a plain word and move the glyph into the client. Record which happened in
    this file before continuing — the rest of the plan does not depend on which way it went.
- [ ] **Read a working descriptor out of the store — the check everything else rests on.** With the
  stack up and Redux devtools open, go to Open Questions by menu (while it still exists) and click a row.
  Inspect `state.activities`: two entries, and the child's descriptor is the template. Expect
  `{ module: "OpenQuestion", instance: "OpenQuestion_DM/<uuid>", model: "OpenQuestion_DM" }`.
  **If `instance` is a bare uuid there, seam 2b's docRef composition is wrong** and every navigation in
  this change drops the prefix. Thirty seconds, and it gates the rest — do it first.
  - Seam 2b already settles the rest from source: cross-module navigation works, `model` is mandatory
    and is the DM id, the teardown handshake is obligatory, and `create` alone triggers the load. This
    step verifies the one claim that depends on what the *server* returns, not on the client sources.
  - The same answer governs **seam 4's read**, not only navigation: `OpenQuestion.ConversationId` and
    `Conversation.CurrentQuestionId` both hold bare ThingIDs, so `useThingById` composes a docRef too.
    Confirm in the same sitting that a document read by composed docRef returns the document.
- [ ] **Spike the read-by-id.** In a scratch component, read one `OpenQuestion_DM` document by ThingID
  through `dataservices-access` and log its `Prompt`. Verify: it resolves under the logged-in User's
  rights, and decide from what it took whether `useThingById` needs a saga or a plain effect. Note the
  chosen call in `architecture.md`'s seam 4.
- [ ] **Confirm the value accessor.** Establish whether `@com.mgmtp.a12.kernel/kernel-md-facade` gives
  a documented way to read a repeated group's instances from a `JSONDocument`. If it does, `entries.ts`
  uses it; if not, it indexes by name. Note which in `architecture.md`.
- [ ] Revert every spike in this phase. Nothing from it is kept except the notes and the answers.

## B — The semantics, as pure functions

Everything in this phase is testable with `just test-client` alone: no store, no server, no browser.

- [ ] Capture a fixture: a real `Conversation_DM` JSON document with a full invoice-slice transcript —
  `system`, `prompt`, `assistant`, `tool-intent`/`tool-result` pairs, an `askUser` intent, an `answer`,
  an `approval-request` — into `client/src/test/fixtures/conversation.json`. Take it from a running
  stack, not by hand.
- [ ] Write `client/src/test/components/conversation/entries.test.ts` first: reading the fixture yields
  Entries in `seq` order with the fields the Transcript renders; a document with no `Entries` yields an
  empty list; an unknown field is ignored rather than throwing.
- [ ] Implement `client/src/components/conversation/entries.ts` to satisfy it. Only the fields the
  Transcript renders — `seq`, `at`, `role`, `kind`, `text`, `toolName`, `toolArgs`, `toolResult`,
  `questionId`, `promptTokens`, `completionTokens`.
- [ ] Write `speaker.test.ts` first, one case per row of domain.md's Speaker table, including: an
  unknown kind falls back to Machinery and keeps its kind visible; `tool-intent` with
  `toolName = "ui.askUser"` is Assistant speech, not a Receipt; `prompt` is Machinery and **not**
  Human, though its `role` is `user`.
- [ ] Implement `speaker.ts`.
- [ ] Write the clustering test: Entries group into clusters, and a separator is due when the day
  changes **or the gap reaches one hour** — both boundaries tested, including 59 minutes on the same day
  producing none; a `tool-intent` and its `tool-result` pair into one Receipt; an unpaired `tool-intent`
  stands alone as an open Receipt.
- [ ] Implement the clustering in `entries.ts`, using `date-fns` for the separator's text.
- [ ] Write `cost.test.ts` first: the fixture's tokens sum to the expected figure; Entries without
  usage contribute nothing; a Conversation with no Entries yields zero rather than `NaN`. Implement
  `cost.ts`. The formatting helper always prefixes `≥` and never renders a bare total; grouping comes
  from `Intl.NumberFormat` on the browser locale, not from a hardcoded separator.
- [ ] Write `subject.test.ts` first, one case each: each of the four `TRIGGER_ELIGIBLE_MODELS` yields
  `{ module, instance: "<Model>/<thingId>", model: "<Model>" }` — the module from a **whitelist**, never
  from stripping `_DM`, and the instance a **composed docRef** (seam 2b); an unrecognised `subjectModel`
  yields nothing; an empty `subjectThingId` yields nothing; a Conversation with `scheduledFor` and no
  subject yields nothing. Implement `subject.ts`.
- [ ] `just test-client` green.

## C — The Transcript, rendered

- [ ] Add `"conversation-transcript"` to `WidgetAnnotationValue` in `components/widgetAnnotation.ts`.
- [ ] Add `client/src/components/CustomScreenElements.tsx`: the `formModelMap.CustomScreenElement`
  component. Dispatches on the `widget` annotation; an unknown or absent value renders nothing (and
  logs once), because a modelled placeholder no developer filled in must not break a form.
- [ ] Register it in `appsetup.ts` by spreading, beside the existing `Control` override.
- [ ] Write component tests (`@testing-library/react`, as the markdown editor's tests do) over the
  fixture: one bubble per Entry; the Human bubble on the accent side; a Receipt collapsed by default
  and expandable to its arguments and result; token cost as a footnote on the assistant bubble it
  belongs to; separators between clusters.
- [ ] Implement `Bubble.tsx`, `Receipt.tsx`, `icons.ts`, `ConversationTranscript.tsx`. Styling via
  `styled-components` and `theme.colors.*` — no literal colours. The transcript is the bounded box:
  `height` from the model element, `overflow-y: auto`, the header slot sticky at its top.
- [ ] Implement `client/src/sagas/openForeignForm.ts` per seam 2b, and register it in `appsetup.ts`'s
  `addCustomSagas` beside `LoadModelGraphSaga`: cancel every top-level activity and honour a veto, push
  the `{ module: masterModule }` master, then push the detail with `initiatingActivityId` and a descriptor
  carrying `module`, the composed `<Model>/<thingId>` **docRef** as `instance`, and `model`.
  `masterModule` is a **parameter**, not a constant — the Header's *about* link passes the subject's own
  module so the Invoice list sits beside the Invoice, and phase D's Answer button passes `Conversation`.
  It lands here rather than in phase D because the *about* link is its first caller.
  - [ ] Unit-test the descriptor it builds — a bare ThingID in, a docRef out, `model` always present,
    `masterModule` honoured — and that a vetoed cancel dispatches no push at all.
- [ ] Write the Header's component tests first: it names the Assistant and the title; it shows 🛑 when
  `waitingFor = user` and the finish reason when the Conversation is over; the *about* slot is a link
  for a subject Thing, the `scheduledFor` instant when there is none, and a link to the parent when
  `parentConversationId` is set; the cost reads `≥`. Implement `TranscriptHeader.tsx`.
- [ ] Replace the Entries `InlineRepeat` in `Conversation_FM` with the `CustomScreenElement`
  (`name: "ConversationTranscript"`, `widget: conversation-transcript`, `exposes: f_entries`, a
  `height`). Keep the Result and Last error sections and their order. `exposes` belongs **here only** —
  it is a claim about this form's own Document Model, and `Conversation_DM` is the one that has
  `f_entries`.
- [ ] Set `collapsible: true, initiallyCollapsed: true` on `Conversation_FM`'s `ConversationHeader`
  `MultiColumnSection`. All thirteen Controls stay — ADR-0008 is still met — they are simply one click
  away, since the pinned header now says what a reader needs.
- [ ] Teach `import/validate-models.mjs` the `exposes` rule, both halves: a `CustomScreenElement`
  annotated `exposes: <groupId>` marks that group and every field under it as referenced for the
  ADR-0008 check, **and** it is an error if the annotation names a group the bound Document Model does
  not have. Add three cases to `import/validate-models.selftest.mjs` first — a form whose only reference
  to a group is such an element produces no warning; one with a typo'd `exposes` produces an error rather
  than silently covering nothing; and a `CustomScreenElement` carrying **no** `exposes` is legal and
  silent, because that is what `OpenQuestion_FM`'s will be.
- [ ] Correct that file's `INTENTIONALLY_UNEXPOSED` comment for `f_maxTurns`: the Header shows
  `turn 4/20`, so *"Runtime bookkeeping the User has no use for"* is no longer true of it. It stays on
  the list — the exclusion is about Controls — but the comment must stop asserting something false.
- [ ] `just test-models` green with **no new warnings** (12 would otherwise appear for the Entry
  fields — `f_entry_idempotencyKey` is already excluded); `just test-client` green.
- [ ] Run the stack, open a Conversation, scroll to the last Entry, screenshot both the top and the
  scrolled state into `tmp/`. It has to look like a thread and the header has to still be there — if
  either fails, this is the phase to fix it, not a later one.
- [ ] Click the header's *about* link and land on the subject Thing's form. Then open a Conversation
  born of a Schedule and confirm it shows its instant and no link. Finally, temporarily point a
  Conversation's `SubjectModel` at a model with no module and confirm the header renders text rather
  than creating a silently invisible activity — that is what the whitelist is for.

## D — The pending question, in context

- [ ] Implement `useThingById` per phase A's answer, read-only, failing soft, composing the docRef from
  the Model and the bare ThingID it is given. Unit-test the failure paths: no id, a rejected request, a
  document that does not exist — each yields "nothing to show", never a throw.
- [ ] Test the question form's degraded state, since that is the one where the fetched document *is* the
  context: with the Conversation unreadable, the Header falls back to the OpenQuestion's own
  `assistantKey` and `kind` beside a message line, and the prompt and answer controls still work. The
  screen must stay answerable — that is the only thing that must never break.
- [ ] Write the test first: given a Conversation with `currentQuestionId` and a loaded OpenQuestion,
  the Transcript ends in a Pending Question Bubble carrying the question's prompt, its options, and an
  **Answer** button; given a Conversation with no `currentQuestionId`, there is no such bubble; given
  an id whose document is missing, a single message line and the rest of the thread intact.
- [ ] Implement `PendingQuestion.tsx`. The prompt renders through the read-only
  `MarkdownRichTextEditor`. The **Answer** button asks `openForeignForm` for
  `("OpenQuestion", "OpenQuestion_DM", currentQuestionId, "Conversation")` — it does not build a
  descriptor itself, and the last argument is why the User lands back among Conversations.
- [ ] Verify in the browser that the approval question — whose `approval-request` Entry has no text —
  shows its words. This is the case the whole change exists for.
- [ ] Verify the Answer jump against seam 2b's expected action sequence, devtools open:
  `CANCEL_REQUESTED` → `CANCEL` ×N (and **no** `SET_CANCEL_CONFIRMATION_REQUIRED`, since the source form
  is read-only) → `RESPONSE_CANCEL_REQUESTED { cancelled: true }` → `PUSH` ×2 → `LOAD_DATA` ×2 →
  `SET_DATA` ×2. Then assert the state it leaves: **exactly two** activities, the network request
  constraining `/__meta/docRef` to the composed docRef, and no
  *"Active screens of module … found in activities"* console error — that one is the leak alarm.
  Choose a question that is **already answered**, so it is absent from `OpenQuestionPending_QeM`'s ten
  unanswered rows: that proves the jump does not depend on the overview's list, which is exactly why
  `CRUDActions.selectRow` was unusable.
- [ ] Press the landed form's `Cancel` and confirm it returns to the **Conversations** overview, not to
  a blank region — `empty-div` there means the master push in step 2 is missing or misparented.
- [ ] Type into the answer field, then `Cancel`, and confirm the dirty-handling dialog *does* appear.
  It proves the veto path is live on the new route, which is the whole reason answering stayed on this
  form.
- [ ] Add the same `CustomScreenElement` to `OpenQuestion_FM`, above `section_answer`, **carrying
  `widget` and not `exposes`** — it renders another document's Entries, and `OpenQuestion_DM` has no
  `f_entries` group, so the coverage claim would be false and phase C's own validator rule would fail the
  build. It reads the
  Conversation named by `ConversationId` through the same hook. It carries the same pinned Header — the
  question screen has to say which Assistant and about what, and it now does so from the Conversation
  rather than from a repeated `assistantKey`. Its Transcript shows no Pending Question Bubble; the
  answer controls beneath it are that bubble.
- [ ] Split `OpenQuestion_FM`'s `SectionQuestion`: `grid_prompt` stays in it and stays open; the four
  Controls of `grid_question` move into a new **Details** section with `collapsible: true,
  initiallyCollapsed: true`. A `ControlGrid` cannot be collapsed on its own, and collapsing the section
  as it stands would hide the question's words along with the machinery. Every `elementRef` still
  appears exactly once, and `fieldConfiguration.field[]` is untouched.
- [ ] `just test-models`, `just test-client` green. Screenshot both screens into `tmp/`.

## E — One menu entry, one marker

The phase that changes navigation. E2E moves in the same phase, so the suite is never red for a reason
that is not a real one.

- [ ] `AssistantsAppModel_AM`: delete `OpenQuestionModule.menu`; set
  `content.initialActivity.descriptor.module` to `Conversation`. Leave both flows and all scenes.
- [ ] Add the 🛑 `ExpressionColumn` to `Conversation_OM` (phase A settled its form), with
  `rowActionGroup.actions` untouched and the `Waiting for` reference column kept beside it.
- [ ] `e2e/tests/base/2-navigation.spec.ts`: drop the *Open Questions* row from `MODULES`. Seven
  entries remain, each still checked against a column only its own overview declares.
- [ ] `e2e/tests/base/7-forms-open.spec.ts`: drop `"Open Questions"` from its `MODULES` list. It
  navigates by `clickMenuItem`, so with no menu entry it cannot reach that form at all — leaving the
  string in is a test that can only fail. The question form's *"opens without a post-processing error"*
  coverage moves to the new transcript spec and the invoice slice, both of which reach it the way the
  User now does. Note in the spec's doc comment why one module is missing from a list that documents
  itself as covering every module.
- [ ] `e2e/tests/base/5-localization.spec.ts`: both locale tests assert the **welcome page's**
  `CONTENTBOX_TITLE` — *"Open questions"* and *"Offene Fragen"*. The welcome page is now Conversations,
  so they become *"Conversations"* / *"Konversationen"*, and the comment naming the first module goes
  with them. (The separate localisation removal deletes this file; until it lands, it has to be true.)
- [ ] `e2e/tests/flow/2-restart.spec.ts`: `loginFreshly` waits for
  `getByRole("link", { name: "Open Questions" })` as its the-app-is-up signal. It waits for
  *Conversations* instead. Nothing else in that spec changes.
- [ ] `e2e/pages/OpenQuestionPage.ts`: rewrite `openQuestion()` to route through **Conversations**,
  addressing the row by *(subject, assistant)* — see architecture.md's *Addressing one Conversation row*.
  Searching the conversation's own ThingID **cannot** work any more: it was findable only because
  `OpenQuestion.ConversationId` was an indexed field on the document the old overview listed, and no
  Conversation field or column carries a Conversation's own id.
  - [ ] Search the **subject** ThingID — indexed, and inherited by a called Assistant
    (`services.ts:90`), so every Conversation in one Document's tree matches. Narrow the rows by the
    existing `Assistant key` column. `conversationExistsFor(assistantKey, subjectThingId)`
    (`watcher.ts:872`) is the Runtime's birth-dedup guard, so that pair identifies exactly one row.
  - [ ] Add `subjectThingId` to `RaisedQuestion` in `e2e/utils/agents.ts` — one line, read from the
    Conversation body `waitForRaisedQuestion` already has in hand. `assistantKey` is there already.
  - [ ] Then press **Answer** on the Pending Question Bubble and assert the question form as it does
    today. **Delete the prompt-disambiguation**: `distinguishingText` and the two-rows-per-conversation
    reasoning existed because the old overview listed an answered question beside an unanswered one. A
    Conversation has one `currentQuestionId`, so the pending bubble is unique — and say so in the doc
    comment, replacing the paragraph that explains the old problem.
  - [ ] Keep the rest of that doc comment's substance: it still only *fills in* fields, and it still
    leaves `answeredAt` empty on purpose.
  - [ ] Add the test IDs the page object needs to `e2e/types/testIds.ts` and to the components:
    the transcript, a bubble, a receipt, the pending question, the answer button, the blocked marker,
    the header and its *about* link.
- [ ] New `e2e/tests/base/8-conversation-transcript.spec.ts`: on a Conversation with entries, the form
  shows bubbles and **no** `table-body-row` for Entries; a blocked Conversation shows the marker in the
  overview and an unblocked one does not; the pending question's words are on the Conversation form;
  the header is visible, and **still visible** after the transcript is scrolled to its last Entry; its
  *about* link navigates to the subject Thing's form.
- [ ] `just test-e2e` green, including `flow/1-invoice-slice.spec.ts` — both answers now given through
  the new route — and `flow/2-restart.spec.ts` passing on its one-line change. Five existing e2e files
  are touched in this phase, not two: `2-navigation`, `7-forms-open`, `5-localization`, `2-restart` and
  `OpenQuestionPage`. Anything still red here is a real finding, because nothing is left that the AM
  change is known to break.

## F — Say what changed

- [ ] `specs/system/functional.md`: rewrite *Answering Open Questions* and *Watching an Assistant
  work*. Delete *"It is readable, but it is a data grid, not a transcript view."* — the sentence this
  change exists to remove. Correct *"Eight navigation modules"* to seven and name the landing page.
  Update the invoice-slice journey's `U->>UI: opens Open Questions, confirms` steps.
  - [ ] Correct *"Nothing adds them up — the transcript is the record"*. Something adds them up now:
    the Header. Keep the sentence that follows it — the total is a lower bound — because it is why the
    Header shows `≥`, and describe the Header's four facts where the Conversations module is described.
- [ ] `specs/system/architecture.md`: record the three new client seams — the custom screen element, the
  read-by-id, and cross-module navigation — and the rule that reads may cross documents and writes may
  not. Include the docRef composition, since all three seams need it and no Thing carries one.
- [ ] `README.md` around line 185: the navigation list loses *Open Questions*, and *"Start at Open
  Questions"* becomes *"Start at Conversations — the rows marked 🛑 are waiting for you."*
- [ ] `import/models/CONVENTIONS.md`: its overview section documents `content.columns[]` entries as
  `{id, label[], width, elementRef, sortable, preferredSorting}`. The 🛑 column has `name` and
  `expression`, no `elementRef`, and cannot be sortable — record the second column type, what it is for,
  and that anything its expression touches must be `indexed`. Add the `CustomScreenElement` +
  `widget` / `exposes` convention for form models in the same pass.
- [ ] `docs/adr/0021-a-question-is-answered-in-its-conversation.md`, in the house form: context, the
  decision, the alternative rejected (answering inside the Transcript) and why, consequences.
  **Numbered 0021, not 0019**: this artefact was written before `operations-as-things` landed, and that
  change took 0019 (*An Operation is a Thing*) and 0020 (*"Tool" is the provider's word*). Two ADRs
  sharing a number is worse than a gap, and `scripts/check-docs.mjs` counts the directory.
- [ ] `CONTEXT.md`: add **Transcript**, **Conversation Header**, **Speaker** and **Blocked** to the
  glossary if the terms are used outside this change's own documents — and only then.
- [ ] Record the dormant models: `specs/system/functional.md` should say that the Open Questions
  overview scene, `OpenQuestion_OM` and `OpenQuestionPending_QeM` are kept unreachable on purpose, for a
  future Operation that shows the User a list — and that nothing reads them until then.
- [ ] `just test` green end to end. Screenshots of the overview with 🛑, a transcript, and the Answer
  Surface, kept with the change.

## Not in this change

Written down so it is not rediscovered as a gap: no virtualised transcript, no live update while the
Runtime drives a Conversation, no markdown in ordinary bubbles, no answering from the Conversation
screen, no `Blocked` field and no stored cost total on the Document Model, and no change to the Open
Question Model, its overview or `OpenQuestionPending_QeM`.
