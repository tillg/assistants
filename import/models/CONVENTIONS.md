# Model conventions

Every model in this folder follows these rules. They are not style preferences — most of them
exist because the A12 query API is narrower than it looks, and the Runtime's watcher queries are
the system's hot path. See `specs/changes/first-running-system/architecture.md`.

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
    "annotations": [{ "name": "roles", "value": "user" }],
    "modelReferences": []
  },
  "content": { ... }
}
```

`{"name": "roles", "value": "user"}` is **mandatory on every model header**. The role must exist
in `import/auth/roles.yaml` or the model is rejected with `COMMON_ROLE_NOT_IN_ROLES_MODEL`.

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

Two traps:

- **Each `elementRef` may appear at most once** in `fieldConfiguration.field[]`. Duplicates cause a
  runtime "Post processing for model failed" that the model checker does not catch.
- `"readonly": true` in `fieldConfiguration` has no effect on an `EnumerationType` — put it on the
  Control instead.

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
Keep overviews to scalars — never a column into a repeating group. Include a `rowActionGroup`
with a confirmed `delete` action and a `subHeaderBox` with an Add button, except where the
Runtime, not the User, owns the lifecycle (`Conversation`, `RuntimeState`, `OpenQuestion`).
Those three omit **both**: they carry `"leftSlot": []` and no `rowActionGroup` at all. The
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
| `Conversation`, `RuntimeState` | **Runtime only** — the form is read-only |
| `OpenQuestion` | Runtime writes it once at creation, then **the User only** |
