# Proposal — look at the invoice without leaving the page

## What

Open a Document whose attachment is a PDF, and see the PDF.

Today the attachment field shows a MIME-type icon and a filename. To read the invoice the User
downloads it, finds it in their downloads folder, opens it in a separate application, and comes back.
That is four actions and a context switch to answer *"what does this actually say?"* — which is the
question they opened the Document to ask.

| | Today | After |
|---|---|---|
| a PDF attachment | an icon and a filename | the first page, rendered, inline |
| reading it | download → locate → open elsewhere → return | it is already on the screen |
| an image attachment | already previewed by A12 | unchanged |
| a non-previewable attachment | an icon and a filename | unchanged |

**This is a reading affordance and nothing else.** No Thing changes, no field is written, no Operation
is added, and nothing an Assistant does is affected. It is the smallest change in this repository so
far, and the interesting part is not the feature but what the platform will and will not do for us.

## Why

**Because the Documents overview is now a real inbox.** Before the letterbox, a Document existed
because the User had just typed its text in — they already knew what it said. Now post arrives on its
own and the first thing the User wants from a Document they have never seen is to look at it. The
system got a front door and never got a window.

**Because one forwarded invoice is three Documents, and the User has to triage them.** A real mail
from a builder carried the invoice, a letterhead logo and a *Widerrufsbelehrung*. The Receptionist
classifies two of those `other`, but the User will still want to check, and "check" currently means
three downloads. A preview turns triage into scrolling.

**Because a scanned invoice has no text at all.** Where `document.extractText` reports
`no-text-layer` and no vision profile is configured, `extractedText` is empty and the Document's own
form tells the User nothing. The bytes are right there; the reason they cannot be seen is that nobody
rendered them.

**And because it is the cheap half of "can I trust this?"** The Receptionist writes a
`classificationNote` saying what it thinks a Document is. Checking that judgement against the
document itself is exactly the supervision this system is built around — *the User is the supervisor
of every Assistant's activity* — and supervision that requires a download is supervision that will
not happen.

## What A12 does not do

Worth stating up front, because it is the reason this needs code at all. The Form Engine's file
picker previews **images only**. From the modelling documentation:

> **file preview (default):** Renders the attachment as a `File Picker`, which will show a thumbnail
> for uploaded **image** files. If the uploaded attachment is not an image or no valid thumbnail could
> be retrieved by the AttachmentHandler, an icon will be shown.

and:

> Images will be displayed directly within the model if the exposition is not set to compact. **All
> other files can just be downloaded.**

So there is no `Document_FM` setting to switch on, and no exposition that does this. A PDF is, to the
platform, a file with an icon.

## How the bytes are fetched — settled, in a browser

Two steps, both measured on the wire in a live session:

1. `POST /api/v2/rpc` with the User's Keycloak bearer token — `LOAD_ATTACHMENT_URL`, taking
   `{attachmentId, docRef}` — returns
   `{"location": "http://localhost:8082/cs/download/<ticket>?filename=…"}`
2. `GET` that location — **no Authorization header, no cookie** — returns the PDF.

The UUID in that URL is a **single-use download ticket**, not a content-store id. Replaying it answers
`error.content-store.ticket.unavailable`; two consecutive `LOAD_ATTACHMENT_URL` calls mint two
different tickets; even a bare `HEAD` spends one. `/cs/download/{id}` is deliberately unauthenticated
— it is on the UAA introspection whitelist — because **the ticket is the capability**.

### The earlier failure was mine, and worth recording

An earlier draft of this document asserted that `LOAD_ATTACHMENT_URL` was broken here, that
`content-storage=db` was the likely cause, and that every attachment the mail ingest had stored was
therefore unreachable. All of that was wrong, and the mistake is instructive: the `attachmentId` and
`docRef` I tested with were **stale**. I had deleted and re-ingested those Documents myself while
fixing an unrelated bug, and then diagnosed a platform fault from identifiers that no longer existed.
Side by side against the live server, the stale pair reproduces `error.attachment.notFound` exactly
while the current pair returns a location.

`content-storage=db` is a red herring — the content store issues tickets regardless of where the bytes
are persisted.

## What actually makes this hard

Not the fetching. Four obstacles, every one measured in the browser rather than reasoned about:

| | Finding |
|---|---|
| **`Content-Disposition: attachment`, unconditionally** | a live `<iframe src={location}>` stayed blank and Chrome **downloaded** the file. `?disposition=inline` is ignored. This alone rules out the obvious implementation |
| **CORS blocks reading the bytes into JS** | `fetch(location)` from `http://localhost:8081` fails — no `Access-Control-Allow-Origin`. The frontend's nginx proxies `/api` and `/actuator` only, so `/cs` is a different origin. So the blob-URL workaround does not work either |
| **The ticket is single-use** | a preview must mint its own, and must not spend the one the Download menu item is about to use. A *failed* CORS fetch still reaches the server and consumes it |
| **No `Accept-Ranges`, no `Content-Length`** | the response is chunked, so incremental or range-based loading is impossible. Any reader gets one full read or nothing |

**Consequence, and it changes the shape of the change: this is not client-only.** An inline preview
needs a same-origin, authenticated endpoint on the application server that reads the attachment and
re-serves it as `Content-Disposition: inline`. That is a server change, and it is the honest cost.

## Scope

**In scope**

| Area | What changes |
|---|---|
| **A preview component** | `client/src/components/document/` — fetches the attachment, renders it, revokes the object URL on unmount. Read-only |
| **Where it appears** | the Document form, beneath or beside the attachment field. Exact seam depends on the answer above |
| **PDF only** | images already work; everything else keeps today's icon |
| **A server route** | a same-origin, authenticated endpoint that re-serves the attachment as `Content-Disposition: inline`. Forced by the findings above, not a design preference |
| **Tests** | component tests for the three states (loading, rendered, refused), a server test for the route, plus one e2e that opens a Document and asserts the preview is present |

**Out of scope**

| Not doing | Why |
|---|---|
| Replacing the attachment control | upload, replace and delete all work; this adds a view and takes nothing away |
| A custom Form Engine `WidgetMap` entry | a bigger footprint in the form engine's own extension surface. Only if a plain component cannot be placed |
| Previewing anything but PDF | images are the platform's job and it does them; Word and Excel need a converter, which is a different change |
| Page navigation, zoom, text selection, search | the browser's built-in PDF viewer provides all of it for free. Building any of it ourselves would be rebuilding a viewer |
| Rendering with `pdfjs` in the client | the browser already has a PDF viewer. `pdfjs-dist` is in the **Runtime** to extract text without a canvas, which is a different problem |
| Fixing the busy-vs-broken tile state | a real defect, and the neighbouring session's to design |

## Expected outcome

The User opens *"Fwd: Abschlagsrechnung RE0520 von A.H-Bau — Abschlagsrechnung_RE0520_17.08.2026.pdf"*
and sees the invoice: A.H-Bau's letterhead, `Gesamtbetrag 3.570,00`, the IBAN. They can tell in one
glance that the Receptionist classified it correctly, and that the `Logo.pdf` Document beside it is a
logo.

Nothing else about the system changes.
