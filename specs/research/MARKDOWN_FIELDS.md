# Markdown Fields — open research questions

Several Models need long-form prose rather than plain strings — most importantly the Assistant Model, whose prompts are markdown ([ADR-0003](../../docs/adr/0003-assistants-are-things.md)). A markdown field is a **String field carrying an annotation**; A12 already supports annotations, so this uses native A12 features and requires no change to A12 itself.

The mechanism is settled. What follows is not.

## Q1 — May markdown link to Things, and in what form?

A prompt saying *"file this under the renovation process"* is entirely natural, and if such references resolve to Things we have invented a reference type that the Model layer can neither see nor validate.

**Decision: allow Thing links, in an explicit ThingID-based form — not free-text wikilinks.** Two payoffs: a rename never breaks a prompt, and *"what references this Thing?"* stays answerable. Free-text wikilinks are the tempting version and they rot silently.

Open questions this leaves:

- What is the concrete link syntax, and does the markdown editor resolve it to a readable label when rendering?
- Do Thing links participate in referential integrity — can a Thing be deleted while a prompt still links to it?
- Are links to Things whose Model is unexpected (a prompt linking to a Payment where a Process was meant) worth validating at all, given prompts are prose?

## Q2 — Which editor, and what do we reuse?

We take an existing **A12 markdown editor from another A12 project** rather than building one.

To settle: which project, what state it is in, how much of it is reusable as-is, whether it renders Thing links (Q1), and how it is wired into a generated FormModel so that a markdown-annotated String field automatically gets the markdown editor rather than a plain text input.

## Q3 — Which markdown-specific operations does the Data Service provide?

A markdown field is a String to the Data Service, but some operations only make sense for markdown, and it is an open question which of them belong in the ThingStore rather than in Assistants:

- **Full-text search** across markdown fields, and whether it is markdown-aware (ignoring syntax, weighting headings).
- **Extracting the outgoing Thing links** from a markdown field, so that "what references this Thing?" is a Data Service query rather than a scan.
- **Rendering** — does the Data Service serve rendered HTML, or is rendering purely a client concern?
- **Validation** — is the markdown flavour enforced on write (proposal: plain CommonMark), and are dangling Thing links rejected or merely flagged?
- **Section-level access** — reading or replacing a single section of a long markdown field, which matters if Assistants are ever to amend prompts rather than rewrite them.

## Q4 — Which flavour?

Proposal: boringly standard **CommonMark**, plus the Thing-link extension from Q1 and nothing else. To confirm against whatever the reused editor (Q2) already speaks.

---

# Findings — what building it settled (2026-08-09)

The [first running system](../system/architecture.md) put markdown fields to
work. An Assistant's system prompt, an Open Question's prompt and the User's answer to it, a
Document's extracted text, a Process's summary and the note fields on Invoices and Parties are all
markdown, edited in the ordinary A12 form. Q2 and Q4 are answered. Q1 and Q3 are not, and the build
says something about each.

## Q2 — answered: the editor is lifted from `w12-on-a12`

The editor is `w12-on-a12` at commit `6b8df45`, which is on the **2026.06 A12 line** — the same
line this repository is built on (D-003), so nothing had to be ported. The whole editor tree was
copied: a Lexical editor with a visual/source toggle, its transformers, nodes, plugins and toolbar,
along with the localisation subtree and the colour palette it depends on.

Two things were deliberately left behind.

- **The entire collaborative-editing subsystem.** It is gated on a `collab-field` annotation, and we
  never set it — without the annotation the collaborative boundary falls straight through to the
  single-user editor. Dropping it removes a peer-to-peer document-syncing dependency and changes no
  behaviour we wanted.
- **The CDD-coupled inline-attachment path.** Inserting a document attachment as an image resolves
  it through the composed document — `CddSelectors.cdd(activityId)`. Our form models bind directly
  to their document model with no composed-document layer, so that lookup would resolve to
  `undefined` on every one of our forms. The image dialog survives, restricted to external URLs, and
  says so where it is implemented.

### The mechanism, precisely

A field becomes a markdown field through **three coordinated facts**, none of which does anything
alone:

1. `lineBreaksPermitted: true` on the `StringType` in the document model — without it the kernel
   rejects a newline outright;
2. `"exposition": "AREA"` for that field in the form model's `fieldConfiguration`, which makes the
   form engine choose a text area rather than a single-line input;
3. `{"name": "widget", "value": "markdown-editor"}` as an annotation on the form model's `Control`.

The third fact means something only because of a fourth, and it is the one worth recording:
**stock A12 does not dispatch widgets by annotation at all.** Widget props carry no annotations, so
the lift brings its own mechanism with it — a `ModelElementBridge` that publishes the `Control`'s
model element into a React context, and a `widgetMap` override that replaces the stock
`TextAreaStateless` widget with the markdown one. The widget reads the annotation out of the context
and renders the stock text area when it is absent. So the "String plus annotation" mechanism this
document opens with is real and uses native A12 features only, but the *dispatch* on that annotation
is ours, not the platform's, and it comes from `w12-on-a12` rather than from A12.

**Constraint**: `lexical` must resolve to a single instance, shared with `widgets-core`. Two copies
break Lexical's `$`-prefixed functions, which assume one module-level editor state. It currently
dedupes because both sides ask for the same version range; nothing pins it and nothing checks it, so
a bump on either side could reintroduce a second copy silently.

## Q1 — still open, and now with evidence

Thing links remain net-new work. The lifted editor has **no cross-document link support of any
kind**: its link plugin handles ordinary external URLs — a dialog, a hover popup showing the raw
URL, `target="_blank"`, a scheme blocklist — and nothing in it resolves an identifier to a label or
knows that a Thing exists. Reusing an editor bought us nothing here, and the first running system
leaves Thing links out of scope for exactly that reason.

The decision above stands unchanged: explicit ThingID-based links, never free-text wikilinks. What
the build adds is the cost — a node type, a syntax, a resolver and a picker, all of it written by
us.

## Q4 — answered: GFM plus remark-directive containers

The flavour is whatever the editor speaks, and it speaks **GFM plus remark-directive containers**:
pipe tables, task lists and strikethrough on the GFM side; `:::admonition{type="…"}`, `:::toc` and
`:::align{to="…"}` blocks, and an inline `:color[text]{value="…"}`, on the directive side.

Two qualifications matter, because the proposal above said CommonMark and the answer is not quite
"GFM" either.

- **There is no remark in the pipeline.** The syntax is implemented as hand-written transformers
  over `@lexical/markdown`, so the dialect is *imitated* rather than parsed by the reference
  implementation. What defines it is the editor's round-trip, not a specification.
- **It deliberately diverges from strict CommonMark.** Newlines are preserved so that blank lines
  round-trip as empty paragraphs, lists indent in steps of two spaces where a strict parser wants
  three, emphasis is written `_like this_`, and colons are not escaped so that prose such as
  `16:00` survives unmangled.

The CommonMark proposal is therefore superseded rather than confirmed. It is defensible because the
editor is the sole producer and consumer of the stored string; it would stop being defensible the
day anything else parses these fields.

## Q3 — still open, and the build needed none of it

The Data Service sees a plain String and offers nothing markdown-aware: no full-text search across
markdown fields, no extraction of outgoing links, no server-side rendering, no section-level read or
replace, and no validation of the flavour on write. Assistants amend a prompt by rewriting the whole
field.

The question stays open, and the absence of pressure on it is itself a finding: at one household's
volume, on fields that one editor writes and one form displays, a markdown field is just a String.
Q3 becomes urgent when Q1 does — extracting outgoing links is what makes "what references this
Thing?" a query rather than a scan, and there is nothing to extract until Thing links exist.
