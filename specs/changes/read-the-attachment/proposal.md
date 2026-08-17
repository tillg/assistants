# Proposal — read the attachment

## What

Two Operations, one prompt edit, and no new Assistant.

| | `document.extractText` | `document.readScan` |
|---|---|---|
| **does** | pulls the text layer already inside a PDF | reads a page image with a vision model |
| **works on** | born-digital PDFs — utilities, telcos, most e-invoices | scans, photographs of paper, faxes |
| **costs** | nothing. Milliseconds, no network | **money per page**, seconds |
| **deterministic** | yes — same bytes, same text, for ever | no |
| **called by** | the **ingest**, on arrival — *and* the Receptionist | the **Receptionist**, and only ever the Receptionist |
| **needs** | `pdfjs-dist` | a vision-capable LLM profile |

Today the Receptionist's prompt says this, at `runtime/src/bootstrap/assistants.ts:48`:

> *"If its `extractedText` is empty, you cannot classify it. Ask for the text with
> `document.requestText` — a human will transcribe it and you will be resumed."*

That is the whole of the system's ability to read an attachment: **ask a human to type it out.** This
change turns those two lines into four, by putting two rungs underneath them.

```
text is already in extractedText   →  nothing to do
attachment with a text layer       →  document.extractText    free, automatic, usually on arrival
no text layer                      →  document.readScan       costs money, page-capped
unavailable, switched off, failed  →  document.requestText    the human pastes it   ← ships today
```

Every rung falls through to one that already works. That is what makes it safe to build in pieces
and safe to switch off in production.

## Why

**Because "a human transcribes it" is the step this system exists to delete.** The
[receive-emails](../receive-emails/) change lets the User forward an invoice with one gesture. If
what waits for them at the other end is *"please open this PDF and type its contents into a box"*,
the gesture bought nothing. The letterbox and the reading are two halves of one useful behaviour,
and only the first half is currently specified.

**Because most invoices are not scans.** A PDF from a telco, a utility, an insurer or any e-invoicing
system carries its text inside it. Extracting it is a library call over bytes the ThingStore already
holds — no network, no model, no cost, no judgement. The system has simply never done it. That rung
alone is expected to carry the majority of forwarded post, and it is the cheap one.

**Because the expensive rung should be a decision, and there is already something that decides.** A
scanned dentist's invoice needs a vision model, which costs money per page. That is exactly the kind
of call the Receptionist is for: it has the Document, it has the covering note ("here's Anna's
dentist bill"), and it can tell a bill worth reading from a junk-mail leaflet. Spending is judgement,
and judgement belongs to an Assistant.

**And because the platform makes the expensive rung small.** Claude's Messages API takes a PDF
directly as a `document` content block — no rasterising, no `poppler`, no canvas, no Tesseract, no
native dependency. Limits are 32 MB and 600 pages per request (100 pages on 200 K-context models),
which is far above any household invoice. What would have been a hard change two years ago is now
mostly a config decision.

## Why this is not a Skill

The reflex is to give the Receptionist a **Skill** for reading PDFs. It should not have one.

A Skill is *instructions for the LLM — judgement, procedure or knowledge, written as markdown*. The
Receptionist's two real Skills earn that: *Reading a German doctor's invoice* is knowledge about GOÄ
fee schedules, and *Telling an invoice from a reminder* is a procedure with a search in it. Neither
could be a sentence.

The ladder above **is** a sentence. It is four lines of prompt in the numbered list the Receptionist
already follows, replacing the two that are there. Writing it as a Skill would mean a markdown
document, its own heading, its own place in the Assistant form, and a reader wondering what knowledge
it contains — for *"try the free one, then the dear one, then the human"*.

**What the Receptionist gains is a tool, not a lesson.** That distinction is the whole of the
recommendation.

## Why `extractText` is called from two places

It looks redundant. It is not, and the reason is a real gap:

| A Document arrives… | via | who notices the empty text |
|---|---|---|
| forwarded by email | the ingest in [receive-emails](../receive-emails/) | **the ingest** — extract on arrival, before the Document is created. The Receptionist never learns a PDF was involved, and no Turn is spent |
| uploaded on the create form | the client and the server | **the Receptionist** — the Runtime is not in that path at all and never sees the upload. So it must be able to ask |

Same code, two callers, and neither one covers the other's case. That is what makes it an
**Operation** rather than a private step inside the ingest.

`readScan` has no such split. It is never called on arrival, because arrival has no judgement and
must therefore never spend money.

## Scope

**In scope**

| Area | What changes |
|---|---|
| **`document.extractText`** | new Operation. Reads a Document's attachment from the Content Store, pulls the text layer, writes it to `extractedText`, returns what it found — or reports `no-text-layer`, which is a *result*, not an error |
| **`document.readScan`** | new Operation. Sends the attachment to a vision-capable LLM profile, writes markdown into `extractedText`. Page-capped, size-capped, and unavailable rather than broken when no such profile is configured |
| **The vision port** | a narrow second LLM interface — **not** a widening of `LlmProvider`. See [architecture.md](architecture.md#why-llmprovider-is-not-widened) |
| **`llm.json`** | an optional `vision` profile name, alongside `active`. Same file, same key convention, nothing else has to know its name |
| **The Receptionist** | step 2 of its prompt, and two grants. **No new Skill.** Nothing else |
| **The ingest** | [receive-emails](../receive-emails/)' mail path calls `extractText` before creating the Document |
| **Cost accounting** | `readScan` returns its token usage, and the Turn that called it records it. See the open decision below |

**Out of scope**

| Not doing | Why |
|---|---|
| **Local OCR** (Tesseract) | a native dependency and a large image, for output that is poor on German invoice layouts. The vision model is better and cheaper than the engineering |
| **Images that are not PDFs** (JPEG, PNG, HEIC from a phone camera) | worth having and deliberately deferred: it is a second attachment path and a second set of limits. `readScan` is written so adding it later is a media-type branch |
| **Extracting from DOCX, XLSX, email `.msg`** | not what arrives. Revisit when one does |
| **Re-reading Documents that already have text** | both Operations refuse when `extractedText` is non-empty, unless explicitly told to replace. Silently overwriting a human's transcription would be the worst bug in this change |
| **A Skill for the Receptionist** | argued above |
| **Automatic `readScan` on arrival** | spending is judgement; arrival has none |

## Two things to settle before implementing

**1. `readScan` costs money, and nothing currently asks.** It is capped by pages, by size and by the
Operation's `Enabled` switch, and it is **shipped without a required approval**. An approval per
scanned invoice would mean two questions for every piece of post and would defeat the automation the
change exists to provide. [ADR-0018](../../../docs/adr/0018-an-operation-may-require-an-approval.md)
already lets the **User** add one to the Operation Thing if they disagree — *"they may add one where
the code demands none"* — so the mechanism is there without us pre-empting their decision. That is
the argument for shipping without one; it is worth disagreeing with now rather than after the first
bill.

**2. The spend would otherwise be invisible.** A `Turn` records what the model charged for it, and
the sum over a Conversation's Turns is already an honest **lower bound**. `readScan` spends on a
model *inside* a Turn without being that Turn's own LLM call — so left alone it would open a whole
new category of unrecorded cost, which is a different thing from the existing known gap. The
Operation therefore returns its usage and the Loop Driver adds it to the Turn's. Cheap, and it keeps
the sentence in [CONTEXT.md](../../../CONTEXT.md) true.

## Expected outcome

The forwarded utility bill needs nobody: the ingest pulls its text, the Receptionist classifies it,
the Accountant asks where to book it. The forwarded *scanned* dentist's invoice costs a few cents and
needs nobody either. The photograph of a crumpled receipt still goes to the User — and that is the
right place for it, because nothing can read it reliably and pretending otherwise would put an
invented amount into the books.

The Receptionist gets two tools and four lines. It does not get a Skill, and it does not get smarter.
