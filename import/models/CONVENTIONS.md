# Model conventions

Every model in this folder follows these rules. They are not style preferences — most of them
exist because the A12 query API is narrower than it looks, and the Runtime's watcher queries are
the system's hot path. See `specs/system/architecture.md`.

## Files and naming

```
import/models/<thing>/<Thing>_DM.json    document model   — the data
import/models/<thing>/<Thing>_FM.json    form model       — how one is shown and edited
import/models/<thing>/<Thing>_OM.json    overview model   — how a list of them is shown
import/models/<thing>/<Name>_QeM.json    query model      — a default constraint for an overview
import/models/AssistantsAppModel_AM.json application model — navigation (owned centrally)
```

Folder names are lower-case singular (`invoice/`, `openquestion/`). Model ids match the filename.

## `modelVersion` per model type

Copy these exactly; they are metamodel versions and move independently of the A12 release.

| Type | `modelType` | `modelVersion` |
|---|---|---|
| Document | `document` | `29.4.0` |
| Form | `form` | `39.0.0` |
| Overview | `overview` | `39.0.0` |
| Application | `application` | `6.0.0` |
| Query | `query` | `0.2.1` |

`query` is the one exception: `@com.mgmtp.a12.querymodel/querymodel-core` declares no `modelType` /
`modelVersion` in its `package.json`, so `collectA12ModelVersions()` never emits a `"query"` key and
nothing checks the value. `0.2.1` is the package's own version, used for traceability.

## Header

```json
{
  "header": {
    "id": "Invoice_DM",
    "modelType": "document",
    "modelVersion": "29.4.0",
    "locales": [{ "code": "en" }, { "code": "de" }],
    "labels": [{ "locale": "en", "text": "Invoice" }, { "locale": "de", "text": "Rechnung" }],
    "annotations": [{ "name": "roles", "value": "user,runtime" }],
    "modelReferences": []
  },
  "content": { ... }
}
```

`{"name": "roles", "value": "user,runtime"}` is **mandatory on every model header**. Both roles
must exist in `import/auth/roles.yaml` or the model is rejected with
`COMMON_ROLE_NOT_IN_ROLES_MODEL`; omitting `runtime` is rejected by `just test-models`, because the
Runtime could not read the model.

Every model is bilingual: every `label` carries both `en` and `de`.

## Ids

- Group id: `group_<thing><suffix>`, e.g. `group_invoice`, `group_invoice_lines`.
- Field id: `f_<name>`, e.g. `f_amount`, `f_issuedByPartyId`. **Ids are opaque and stable** — the
  form and overview models reference them literally, so never renumber one.
- Form control id: `ctrl_<field>`; row id: `row_<n>`; grid id: `grid_<section>`.
- Overview column id: `col_<field>`.

## The four query rules

These are load-bearing. Breaking one produces a watcher that silently returns nothing.

1. **Any field the Runtime filters on is a `StringType` carrying a code — never an
   `EnumerationType`.** A12 indexes enumeration fields by their *localised display text*, so
   `exact_match` on `"waiting"` finds nothing while `"Waiting"` / `"Wartend"` would. Codes are
   lower-case ASCII (`waiting`, `free-text`, `thing-materialised`). 
2. **Never filter into a repeating group.** Constraints cannot address a path inside one. Anything
   the Runtime needs is a top-level scalar.
3. **Every filtered field carries `{"name": "indexed", "value": "true"}`.** Only indexed fields
   are queryable.
4. **Every document model carries the four machine fields** below.

### Giving a code field a picker, without making it an Enum

A code field is a `StringType`, so by default the form renders a plain text box and nothing stops
a human typing `Invoice-Handling` into a field the Runtime filters on `invoice-handling`.

The fix is `hintList` on the `StringType` — A12's form engine dispatches a String **with** a
`hintList` to an autocomplete input rather than a plain one, while still storing the raw string,
so the index keeps seeing ASCII codes:

```json
"fieldType": {
  "type": "StringType",
  "StringType": {
    "maxLength": 40,
    "hintList": [
      { "locale": "en", "values": ["open", "waiting", "done", "abandoned"] },
      { "locale": "de", "values": ["open", "waiting", "done", "abandoned"] }
    ]
  }
}
```

`hintList` is an **array keyed by locale** (`ReadonlyArray<{locale, values}>`) — an object there
fails the model conversion with a `Cannot deserialize ... HintLists` error. Because the values are
ASCII codes rather than prose, both locales carry the same list.

Every code field in this project carries a `hintList` of its permitted values. It is a
convenience, not a constraint — A12 will still store whatever is typed, and the Runtime treats an
unrecognised code as unset.

## The four machine fields

Every `_DM` root group ends with these, in this order:

```json
{ "type": "Field", "id": "f_idempotencyKey", "name": "IdempotencyKey",
  "annotations": [{ "name": "indexed", "value": "true" }],
  "Field": { "fieldType": { "type": "StringType", "StringType": { "maxLength": 200 } },
             "label": [{ "locale": "en", "text": "Idempotency key" },
                       { "locale": "de", "text": "Idempotenzschlüssel" }] } },

{ "type": "Field", "id": "f_createdByConversationId", "name": "CreatedByConversationId",
  "annotations": [{ "name": "indexed", "value": "true" }],
  "Field": { "fieldType": { "type": "StringType", "StringType": { "maxLength": 200 } },
             "label": [{ "locale": "en", "text": "Created by conversation" },
                       { "locale": "de", "text": "Erstellt von Konversation" }] } },

{ "type": "Field", "id": "f_createdAt", "name": "CreatedAt",
  "annotations": [{ "name": "indexed", "value": "true" }],
  "Field": { "fieldType": { "type": "DateTimeType", "DateTimeType": { "format": "yyyy-MM-dd'T'HH:mm:ss" } },
             "label": [{ "locale": "en", "text": "Created at" }, { "locale": "de", "text": "Erstellt am" }] } },

{ "type": "Field", "id": "f_updatedAt", "name": "UpdatedAt",
  "annotations": [{ "name": "indexed", "value": "true" }],
  "Field": { "fieldType": { "type": "DateTimeType", "DateTimeType": { "format": "yyyy-MM-dd'T'HH:mm:ss" } },
             "label": [{ "locale": "en", "text": "Updated at" }, { "locale": "de", "text": "Geändert am" }] } }
```

`idempotencyKey` is what makes creation retry-safe: the ThingStore assigns the docRef, so
`thingstore.create` is *search-then-create* on this field. `createdAt` / `updatedAt` are ours
because `__meta.createdAt` has second granularity with inclusive range bounds, which
double-counts the watermark boundary.

`updatedAt` records **the last Runtime write, not the last write.** It is stamped by
`ThingRepository.update`, and a UI save cannot stamp it: the four machine fields are deliberately
absent from every form (below), and A12's form engine offers no save hook that could reach one — the
only supported saga options are an attachment loader and a document-descriptor selector. So after a
User answers an Open Question in the browser, `__meta.modifiedAt` moves and `UpdatedAt` does not. For
"when did anyone last touch this Thing", read `__meta.modifiedAt`; its second granularity is only a
problem for the watermark, which keys on `createdAt`. Nothing filters on `updatedAt` today, and
anything that starts to has to decide which of those two questions it is asking.

None of the four appears on any form except where a human genuinely benefits (`createdAt` in a
Conversation header). They are on the allow-list of intentionally unexposed fields in the model
validation test.

## Field-type cookbook

A12 has **no** `IntegerType`, no `MoneyType` and no reference type. The complete set is
`BooleanType, ConfirmType, DateType, DateTimeType, DateRangeType, DateFragmentType,
EnumerationType, NumberType, StringType, TimeType, CustomFieldType`.

| Need | Use |
|---|---|
| Short text | `StringType` `{maxLength: n}` |
| **Markdown / long prose** | `StringType` `{"lineBreaksPermitted": true, "noValueValidation": true}` — `lineBreaksPermitted` is **mandatory**, the kernel rejects `\n` without it |
| Machine code | `StringType` `{maxLength: 40}` + `indexed` (rule 1) |
| **Reference to another Thing** | `StringType` `{maxLength: 200}` + `indexed`, named `<what>ThingId`. ADR-0002: a ThingID identifies and nothing more. Do **not** use a relationship model |
| Integer | `NumberType` `{minFractionalDigits: 0, maxFractionalDigits: 0}` |
| **Money** | `NumberType` `{minFractionalDigits: 2, maxFractionalDigits: 2, trait: "amount"}`. The currency goes in the **FM** `fieldConfiguration.field[].suffix`, never in the DM label |
| Date | `DateType` `{"format": "yyyy-MM-dd"}` |
| Timestamp | `DateTimeType` `{"format": "yyyy-MM-dd'T'HH:mm:ss"}` |
| Yes/no | `BooleanType` — takes **no** inner object; tri-state (true / false / unset) |
| Human-only choice | `EnumerationType` `{values: [{value, label[]}]}` — only where the Runtime never filters |

Repeating group: `"Group": {"repeatability": 50, "elements": [...]}`. `1` = single.

### Which characters a string field accepts

No charset is configured anywhere in this repo, and with none configured the kernel's character check
degenerates to "reject any UTF-16 surrogate" — which is exactly every non-BMP codepoint. In practice:

* **Accepted**, on every plain `StringType`: umlauts, ß, €, curly quotes, en dashes, non-breaking
  spaces, Cyrillic, Chinese, tabs, backslashes, colons, quotes. All verified as round-tripping.
* **Refused**: emoji and anything else outside the Basic Multilingual Plane, with
  `ErrorCode: ZeichenNichtImZeichensatz`.
* **Exempt**: any field carrying `noValueValidation: true` — which is every markdown field, and also
  `Assistant.SystemPrompt`, `OpenQuestion.Prompt`/`Text`, `Conversation.Result`/`LastError` and every
  `Entries` text field. Seventeen fields across nine models.

The consequence to design around: an invoice's `ExtractedText` may contain an emoji and a `Title`
derived from it may not, so an Assistant copying text from one field into another can be refused for a
reason that is nothing to do with what it was trying to do. It does at least now *learn* that reason —
`A12RpcError` carries the store's own explanation rather than a generic sentence (BUG-14).

Do not reach for the kernel's `deactivateLegalCharCheck` annotation to widen this: it is declared
internal-use-only by the vendor and would change validation for every field in the model.

## Annotations

`annotations` is a **sibling** of the `"Field"` / `"Group"` payload key, never inside it:

```json
{ "type": "Field", "id": "f_status", "name": "Status",
  "annotations": [{ "name": "indexed", "value": "true" }],
  "Field": { "fieldType": { ... } } }
```

Putting it inside `"Field": {...}` is silently ignored — the classic mistake.

## Form models

Bind directly to the document model. No composed-document layer:

```json
"modelReferences": [
  { "alias": "Invoice_DM", "modelType": "document", "purpose": "data binding", "reference": "Invoice_DM" }
]
```

`purpose: "include"` is forbidden in a form model.

Structure: `screens[] → screenElements[] → MultiColumnSection | ControlGrid → row[] → cell[] → Control`.
A `Control` binds by the literal field id: `{"type": "Control", "id": "ctrl_amount", "elementRef": "f_amount"}`.
Repeating groups render through `InlineRepeat` with `groupRef` and `repeatOverviewColumn[]`.

`content.fieldConfiguration.field[]` carries presentation overrides keyed by `elementRef`:

- **Markdown field** → `{"elementRef": "f_x", "exposition": "AREA"}`, and the Control gets
  `"annotations": [{"name": "widget", "value": "markdown-editor"}]`. All three facts —
  `lineBreaksPermitted`, `AREA`, the annotation — must line up or you get a plain input.
- **Money** → `{"elementRef": "f_amount", "suffix": {"text": [{"locale": "en", "text": "EUR"}, {"locale": "de", "text": "EUR"}]}}`
  (note: in an **OM** the same `suffix` is a *direct array*, without the `text` wrapper).

Three traps:

- **Each `elementRef` may appear at most once** in `fieldConfiguration.field[]`. Duplicates cause a
  runtime "Post processing for model failed" that the model checker does not catch.
- `"readonly": true` in `fieldConfiguration` has no effect on an `EnumerationType` — put it on the
  Control instead.
- **`collapsible` / `initiallyCollapsed` work on a `Section` and nowhere else.** Both
  `FormModel.Section` and `FormModel.MultiColumnSection` declare them
  (`formengine-core/src/models/internal/form-model.ts:498-537`), but only the `Section` renderer reads
  them — `multi-column-section.js` never mentions either, so setting them there converts, validates,
  and silently does nothing. A section that must collapse is therefore a **`Section` wrapping a
  `ControlGrid`**, never a `MultiColumnSection`. A `ControlGrid` cannot be collapsed on its own, so
  hiding *some* of a section's controls means splitting the section rather than collapsing it.
  Note also that a collapsed `Section` **does not render its children at all** (`section.js:37-40`) —
  they are absent from the DOM, not merely hidden, which is what an e2e assertion has to expect.

### `CustomScreenElement` — where a developer puts something the modeller cannot

When modelling runs out — a message thread, a chart — `FormModel.CustomScreenElement` is the
platform's placeholder, and `client/src/appsetup.ts` maps it to a React component exactly as it maps
`Control`. It has **no `elementRef`**: it is `IdNamed`, `Annotated`, `Stylable`, plus an optional
`reference` (a *model* reference) and an optional `height`. Which component renders it is decided by an
annotation, as the markdown editor's Control is:

```json
{
  "type": "CustomScreenElement",
  "id": "custom_transcript",
  "name": "ConversationTranscript",
  "height": 640,
  "annotations": [
    { "name": "widget", "value": "conversation-transcript" },
    { "name": "exposes", "value": "f_entries" }
  ]
}
```

- **`widget` is required** and selects the component. Its permitted values are
  `WidgetAnnotationValue` in `client/src/components/widgetAnnotation.ts`; an unknown or absent value
  renders nothing rather than breaking the form.
- **`exposes` is optional** and names a group **of the Document Model this form is bound to**. Its
  only reader is `import/validate-models.mjs`: it marks that group and every field under it as
  referenced, so ADR-0008's coverage check is satisfied by the custom element the way it was satisfied
  by the `InlineRepeat` it replaced. It is an **error** if it names a group the bound DM does not
  have — without that half a typo would silence the warnings and cover nothing.
- Put `exposes` **only where the claim is true.** `OpenQuestion_FM`'s element carries `widget` alone,
  because it renders another document's Entries and `OpenQuestion_DM` has no such group.
- `height` is not cosmetic where the component owns a scrolling box: `position: sticky` needs a scroll
  ancestor, and if the only one is the form engine's own container a pinned header drifts away with
  the page.

Forms end with a footer box carrying Cancel (`scope: HIDDEN_IN_READONLY_MODE`) and Save
(`event: "CRUD::SAVE"`, `validation: "full"`, `scope: HIDDEN_IN_READONLY_MODE`), plus an Edit
button (`scope: HIDDEN_IN_EDIT_MODE`). A **read-only** form (Conversation) omits Edit and Save.

## Overview models

```json
"modelReferences": [
  { "purpose": "document-model-for-overview", "modelType": "document", "alias": "DM", "reference": "Invoice_DM" }
]
```

`content.columns[]` entries are `{id, label[], width, elementRef, sortable, preferredSorting}`.
Keep overviews to scalars — never a column into a repeating group.

### The second kind of column: `ExpressionColumn`

`OverviewModel.Column` is a union, and the other arm a project reaches for is
`ExpressionColumn` — for a cell that is **derived** rather than read: a marker, a merge of two fields,
a formatting instruction. It has `name` and `expression` and **no `elementRef`**, and it **cannot be
sortable** (`overviewengine-core/src/main/overview-model.ts:149-158, 206-216` — `id`, `width`, `name`
and `expression` are required; `sortable` and `preferredSorting` are not on it at all). Keep the plain
reference column beside it where sorting matters.

```json
{
  "id": "col_blocked",
  "label": [{ "locale": "en", "text": "Blocked" }, { "locale": "de", "text": "Blockiert" }],
  "width": 1,
  "name": "Blocked",
  "expression": "kontext(Conversation) {\n    case [WaitingFor] = \"user\" { \"🛑\" }\n}"
}
```

Four things about `expression`, each of them a way to get it wrong:

1. **It is a string in a little language, not a JSON node tree.** `@com.mgmtp.a12.expression` parses
   it with ANTLR. The forms that matter: `"literal"`, `[FieldName]`, `kontext(<Group>[, delimiter =
   "<s>"]) { … }`, and `case [<Field>] <=|!=> "<value>" { … }` — no parentheses on `case`, and its
   body is mandatory.
2. **It addresses elements by `name`, never by `id`** — `Conversation` and `WaitingFor`, not
   `group_conversation` and `f_waitingFor` — and a field is only reachable inside a `kontext`. The
   overview engine starts at an empty path, so the outermost `kontext` names the DM's root group.
3. **Everything the expression touches must carry `{"name": "indexed", "value": "true"}`.** This is
   query rule 3 again, and the overview engine requires it of an expression's fields.
4. **One `case` matches one field.** There is no AND, so a derived marker has to key on a single
   field — which is a constraint on the Document Model, not a formatting detail.

A non-matching, empty **or absent** value renders an empty cell rather than throwing: the engine's
value getter is `getAssignedObject(…) ?? null`, and `null` folds together with `""`. And the emoji is
fine here — `ZeichenNichtImZeichensatz` (above) is about a `StringType` **field's data**, and a model
file is not document data. Verified end to end: the WCF converter round-trips 🛑 byte for byte and the
shipped interpreter renders it.

Include a `rowActionGroup` — **always**, even when it has no actions. The A12 overview engine
reads `content.rowActionGroup.actions` unguarded, so omitting the key throws
`Cannot read properties of undefined (reading 'actions')` and the table does not render at all.
Where the User should not delete rows (`Conversation`, `OpenQuestion`, `RuntimeState` — all
Runtime-owned), give it `{"actions": []}` rather than removing it. Add a confirmed `delete`
action, and a `subHeaderBox` with an Add button, only where the User genuinely creates and
removes the Thing.
Where the Runtime rather than the User owns the lifecycle (`Conversation`, `OpenQuestion`,
`RuntimeState`), the overview still carries `rowActionGroup: {"actions": []}` — the key is
mandatory — and suppresses creation with an empty `"leftSlot": []` inside `subHeaderBox`. The
`user` role holds `DOCUMENT_DELETE` and there are no ownership policies, so a delete action on
these is a delete: removing the RuntimeState silently disengages the global pause and resets
the watermark, and removing an OpenQuestion strands its Conversation forever.

## Query models — the only way to give an overview a default constraint

An overview model cannot carry a default constraint itself. A **query model** can, and
`overview-engine-data-provider.ts` ANDs it into every `LIST_DOCUMENTS` and `EXPORT` query:

```ts
return QueryBuilder.and(
    modelsState.queryModel?.content.constraint,
    ...FieldBasedFiltering.toOperators(activeFilters ?? {}, modelsState),
    ...
).build();
```

The overview finds it by `purpose` (`selectors.ts`):

```ts
({ modelType, purpose }) => modelType === "query" && purpose === "query-model-for-overview"
```

**The trap**: once a query model is present, the document model is resolved *exclusively* from the
query model's own `document-model-for-query` reference — the OM's `document-model-for-overview`
branch becomes the `else`. A query model that omits that reference silently kills the overview.
Keep the reference on **both** models: the OM needs it for `validate-models.mjs`, the QM needs it
for the runtime.

`content` is a `Query.QueryRoot`, so `targetDocumentModel`, `projectionName` and `paging` are
required by the type even though the overview overrides paging from UI state. Field paths are the
same `/<RootGroupName>/<FieldName>` the Runtime uses (`things.ts` `path()`), **not** field ids.
Leave `content.sort` out unless you mean it — its absence keeps the engine's `/__meta/createdAt`
DESC fallback and lets the columns' `preferredSorting` win.

The `_QeM` suffix is ours. Nothing in A12 maps model types to file suffixes: the WCF converter
dispatches purely on `header.modelType` and writes `<header.id>.json`, and the Data Service
persists any non-`document` model generically.

## Who writes what

This matters more than it looks: **A12 has no optimistic locking**, so a document written by two
parties silently loses one party's work. Every document has exactly one writer at any instant.

| Model | Written by |
|---|---|
| `Party`, `Document`, `Invoice`, `Process` | User **and** Runtime (different documents, never the same one at the same time) |
| `Assistant` | User (the Runtime only reads it) |
| `Operation` | User (the Runtime reads the catalogue once per Turn and never writes it; `just bootstrap`, which runs as the User, creates each Operation and afterwards re-applies only the code-owned fields — `System`, `Kind`, `Parameters`, `Mutating`) |
| `Conversation`, `RuntimeState` | **Runtime only** — the form is read-only |
| `OpenQuestion` | Runtime writes it once at creation, then **the User only** |
