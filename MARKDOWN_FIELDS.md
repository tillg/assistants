# Markdown Fields — open research questions

Several Models need long-form prose rather than plain strings — most importantly the Assistant Model, whose prompts are markdown ([ADR-0003](docs/adr/0003-assistants-are-things.md)). A markdown field is a **String field carrying an annotation**; A12 already supports annotations, so this uses native A12 features and requires no change to A12 itself.

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
