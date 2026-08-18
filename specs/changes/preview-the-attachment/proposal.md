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

## The open question this change has to answer first

**How do we get the bytes?** This is not settled, and pretending otherwise would put a guess in a
spec.

| Route | Status |
|---|---|
| `/api/v2/attachment` | upload only — verified |
| `/cs/download/<UUID>` | the documented download path, but that UUID is a **content-store** id, not the `attachment_id` on the Document |
| `LOAD_ATTACHMENT_URL` (JSON-RPC) | what `platformAttachmentLoader.retrieveDownloadLink()` calls. **Answers `"No URL from attachmentId … could be found"` for our attachments** — verified against the live store with a valid token and the correct `docRef` shape |

The likely cause is that this deployment sets
`mgmtp.a12.dataservices.contentstore.storage.content-storage=db`, so content lives in the Data
Services database rather than at a location a URL could point to.

Which raises a question **larger than this change**: if `LOAD_ATTACHMENT_URL` cannot resolve our
attachments, then the form's own **download** action cannot either — and every attachment the mail
ingest has ever stored may be unreachable from the web application. That is being verified in a real
browser before a line of this change is written, because the answer decides whether this is a
preview feature or a bug report with a preview attached.

## Scope

**In scope**

| Area | What changes |
|---|---|
| **A preview component** | `client/src/components/document/` — fetches the attachment, renders it, revokes the object URL on unmount. Read-only |
| **Where it appears** | the Document form, beneath or beside the attachment field. Exact seam depends on the answer above |
| **PDF only** | images already work; everything else keeps today's icon |
| **Tests** | component tests for the three states (loading, rendered, refused) plus one e2e that opens the real Document and asserts the preview is present |

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
