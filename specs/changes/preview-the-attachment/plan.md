# Plan — settle the unknown, then build the small thing

Step 1 can change what this change *is*. Nothing else should be started until it has an answer.

## 0. Ground rules

- **`client/` is ours for this change**, handed over by the session that owned it. Its last commit
  there is the baseline.
- **Do not run the e2e suite casually.** `e2e/tests/base/0-clean.setup.ts` **deletes `Document_DM`
  Things** whose `Title` starts with `E2E`, and it runs as a setup dependency of the whole `base`
  project. There is real user data in the store — a forwarded builder's invoice and its two companion
  PDFs. See step 6.
- The stack is shared with another session. No `just up`, `just down`, `just build`, no Rancher
  restart, without asking.
- Test-first, as everywhere else here: the component's three states get tests before the component.

## 1. Settle how the bytes are fetched — **DONE**, in a real browser

Recorded here rather than deleted, because the answer is the change's main finding and the mistake in
asking is worth keeping.

- [x] The download **works**. `LOAD_ATTACHMENT_URL` returns
      `{location: ".../cs/download/<ticket>?filename=…"}`; a `GET` on it returns the PDF, 175362 bytes,
      `PDF document, version 1.6`. `Logo.pdf` too. Runtime-uploaded attachments are fine and the mime
      type was set correctly
- [x] **The earlier "the platform is broken" diagnosis was wrong, and the fault was mine.** I tested
      with a stale `attachmentId`/`docRef` — I had deleted and re-ingested those Documents myself
      while fixing the date-format bug. Side by side against the live server, the stale pair reproduces
      `error.attachment.notFound` and the current pair returns a location. `content-storage=db` is a
      red herring: tickets are issued regardless of where bytes live
- [x] The ticket is **single-use**: replay answers `error.content-store.ticket.unavailable`, two calls
      mint two UUIDs, a `HEAD` spends one. `/cs/download/{id}` is unauthenticated on purpose — it is on
      the UAA introspection whitelist, and the ticket is the capability
- [x] What the field renders today: a ~225×170 box with a generic inline-SVG "PDF" wordmark, **no
      thumbnail and no visible filename** (it is in the `title` attribute and a hidden-text span). The
      only affordance is a `more_vert` button opening Replace / Download / Delete. Screenshots in
      `tmp/attachment-field-pdf.png`, `tmp/attachment-menu.png`, `tmp/doc-form-full.png`
- [x] **Four obstacles, all measured:** `Content-Disposition: attachment` is unconditional and defeats
      `<iframe src>`; CORS blocks `fetch` from `:8081` to `:8082`, so the blob workaround fails as-is;
      the ticket is single-use; and the response is chunked with no `Accept-Ranges`, so no incremental
      loading. No `X-Frame-Options`, no CSP — framing is not the problem, the header is

**So the change is not client-only.** Two things to weigh, in this order, before writing the component:

- [x] **CHOSEN: proxy `/cs` through nginx (+ the webpack dev server) and fetch→blob.** Added
      `location /cs` to `client/nginx.conf.template` with a `NGINX_ASSISTANTS_SERVER_CONTENTSTORE_URL`
      (`http://server:8080/cs`) in `compose/docker-compose.yml`, and a matching `/cs` entry in
      `client/webpack.dev.js`. Same-origin dissolves CORS; the client fetches the ticket URL's path,
      makes a blob, and renders it — the blob sidesteps `Content-Disposition: attachment`. **No server
      route, no server rebuild** — the lighter change, and the blob lifetime discipline was mandated
      anyway. The k8s nginx variant proxies nothing (ingress does), so it is untouched
- [x] **Rejected: a server inline route.** Feasible (the server is Spring Boot + A12 DataServices; a
      `@RestController` would fit), but it is a fourth hand-written Java class, an ADR-0023 tension, and
      a `just build` of the shared server image. The proxy achieves the same for one config line
- [ ] **Verify** the chosen path with a real PDF rendered in a real browser before building the
      component around it. Note that the server is "a smart store — three hand-written Java classes";
      adding a fourth deserves the paragraph in
      [architecture.md](architecture.md#therefore-a-server-route-and-this-change-is-not-client-only)
      about why this is not the thing ADR-0023 refused

## 1c. Two platform-side observations, neither ours to fix

- [ ] `aria-labelledby` on the attachment options button references
      `a12-Attachment-f_attachment-content-visible-text`, which **does not exist in the DOM** — a
      dangling ARIA reference, pre-existing and platform-side. Record it; do not patch the platform
- [ ] Playwright's real `page.click()` does not reach this application's React handlers at all — no
      network, no state change, no error. Synthetic `dispatchEvent(new MouseEvent("click", {bubbles: true}))`
      works. Also `appsetup.ts` sets `deepLinking.onlyWelcomePage: true`, so the URL hash is inert and
      navigation is click-only. **Both matter for writing the e2e in step 4** — and the first may
      explain e2e flakiness elsewhere

## 2. The component, tests first

- [x] Tests before the component — all six pass (`AttachmentPreview.test.tsx`):
  - a PDF attachment renders a sandboxed frame with an object URL (and asserts the fetch is same-origin)
  - a `text/plain` attachment renders its text **HTML-escaped** — fed `<script>` bytes, asserted shown
    not executed, no `<script>` in the DOM, `window.__pwned` undefined
  - a `mimeType` with **no registered renderer** (`image/png`) renders **nothing at all**, and mints no
    ticket
  - a failed fetch renders the filename and a download control that re-mints a fresh ticket
  - the object URL is **revoked on unmount** and on `attachmentId` change — both asserted
- [x] Implemented `client/src/components/document/AttachmentPreview.tsx` as a **dispatcher on `mimeType`**
      over a renderer registry — `application/pdf` (sandboxed A4 iframe) and `text/plain` (escaped `<pre>`)
      branches now, the registry the seam for later formats. Fetches via `platformAttachmentLoader`
      (`useAttachmentSource.ts`), **not** a hand-rolled token fetch
- [x] Byte delivery is **mime-agnostic** (`useAttachmentSource`): it mints a ticket, fetches the
      same-origin path, makes one object URL; only the renderer branches on file type
- [x] `sandbox` the PDF iframe with no `allow-same-origin` (empty `sandbox=""`) — **browser-verify this
      actually renders a blob PDF: a sandbox without `allow-same-origin` may block blob navigation in
      some browsers; that is the #1 thing step 3's browser check must confirm**
- [x] **Verified:** `npx tsc --noEmit` clean, `eslint` clean, `prettier` clean, the 6 component tests pass

## 3. Put it in the form

- [x] Placed via the application — `DocumentAttachmentPane` wraps `EnginesViewMap.FormEngine`, no
      `WidgetMap` entry and **no `appsetup.ts` change** (which avoided a collision with the ui-changes
      session). It self-gates on the activity's model, so every other form is untouched (verified: a
      Party form shows no pane and renders normally)
- [x] Layout verified in a real browser: the PDF frame measured **510×722 px = 0.706 ≈ 210/297**, one A4
      page centred, fitting the viewport. Two read-shape corrections were needed and made (see
      autonomous-decisions.md): the document comes from `ActivitySelectors.data`, not the CDD slice, and
      the `Attachment` group reads as a single object, not an array
- [x] **Verified in the browser (the acceptance test):** the real invoice previews inline — A.H-Bau
      letterhead, line items, amounts — and `Logo.pdf` previews as the AH-BAU logo. Screenshots in `tmp/`.
      **One measured correction: the frame carries no `sandbox` attribute** — Chrome refuses its PDF
      viewer in any sandboxed frame; the blob is instead pinned to `application/pdf` to keep the
      un-sandboxed frame safe (DECISIONS.md D-071, architecture.md Security)
- [ ] **Verify:** an image attachment defers to A12 (pane absent), and upload / replace / delete still
      work — exploratory pass in progress

## 4. End to end

- [x] `e2e/tests/base/11-attachment-preview.spec.ts` — uploads a PDF via a new
      `ThingStore.uploadAttachment` (POST `/v2/attachment`, mirroring the Runtime's own uploader),
      creates a Document with `Source: "E2E"` + an `E2E` Title, opens it, and asserts both the
      `document-attachment-preview` pane and the `attachment-preview-pdf` frame are visible.
      **Passed 4/4** (auth → 0-clean → spec → cleanup) against the dev server
- [x] `0-clean` ran clean in that pass — deleted **2** leftover `E2E`/scan Documents and **0** Parties,
      leaving the demo household (all `Source: email`) untouched. That is step 5's verification too
- [x] **Verified:** the spec is green

## 5. The hazard found while planning this — fix or record

Independent of the preview, and found by the neighbouring session: `0-clean.setup.ts` identifies its
own data by a `Title` prefix, and since the letterbox, `Title` is **the subject line of an email**.

- [x] A forwarded mail whose subject begins `E2E` would be **silently deleted** by the next e2e run.
      Untrusted input meeting a delete, which is the combination worth not leaving alone
- [x] **Done — the first option.** `0-clean.setup.ts` now keys the `Document_DM` cleanup on `Source`
      **exactly equal** to `E2E` (a value the ingest never writes — it always writes `email`), not on the
      `Title` prefix. `Party_DM` keeps its `Name`-prefix match (no `Source` field, not fed from untrusted
      input). The preview e2e (step 4) stamps `Source: "E2E"` on the Document it creates. `Source` is a
      free `StringType` (the enum values are only autocomplete hints), so stamping `E2E` is allowed
- [x] **Revised after seeing live data, and verified.** Keying on `Source === "E2E"` *exactly* would
      have orphaned existing `E2E`-titled test Documents with `Source: scan`. Final rule: a Document is
      stale iff `Title` starts with `E2E` **and** `Source !== "email"` — still never deletes an ingested
      Document (closing the hazard, sparing the demo household), while reclaiming every `E2E`-titled test
      Document whatever `Source` it has. The e2e run proved it: 2 `E2E`/scan Documents reclaimed, the
      `email` household left alone

## 6. Documentation

- [x] `specs/system/functional.md` — added an output row: the Document form previews PDF and plain-text
      attachments inline, defers images to A12, and keeps a renderer registry for other formats later
- [x] `README.md` — checked; its "In"/"Out" prose is about text extraction, not this reading affordance.
      No change needed
- [x] `DECISIONS.md` — **D-071** records the whole step-1 finding (the download route works; the
      platform's own path was not broken here; same-origin `/cs` proxy + blob over a server route) and
      the measured `sandbox`/blob-type findings from the browser check
- [x] **No ADR** — held to. A12 previews images, we preview PDFs with the browser's own viewer; the
      `/cs` proxy is one line of config, not a move of where content is stored

## 7. Close out

- [x] `just check` — **my portions pass** (client `tsc`/lint clean, e2e typecheck/lint/format clean).
      The recipe as a whole is red only on *other sessions'* uncommitted WIP in the shared tree —
      `runtime/test/**` (`FireflyFixture`, dynamic-operations) and `ThingLink.test.tsx` (import-order,
      ui-changes). Not this change's files; re-run once those land
- [x] Re-read the diff: no Runtime change, no Model change, no new Operation, no new Skill. The only
      non-client files are the `/cs` proxy config (nginx template + one compose env var) and the e2e
      (cleanup fix, new spec, upload helper, PDF fixture)
- [x] Confirmed in the browser: the User's three real Documents (invoice, `Logo.pdf`, Widerrufsbelehrung)
      are still in the store and still open; the invoice and logo now preview inline

## Sequencing

```
1. how do we get the bytes?  ── DONE: we can, but Content-Disposition and CORS defeat the obvious way
        │
        ├── try: proxy /cs through nginx (one compose line, untested) ─┐
        └── or:  a same-origin inline route on the server ────────────┤
                                                                      ▼
                        2. component ─► 3. in the form ─► 4. e2e ─► 6. docs ─► 7. close

5. the E2E-prefix delete hazard — independent, worth doing even if the preview is abandoned
```

Step 1 is done and it moved the change: this is no longer client-only. The remaining decision is
whether a compose line can replace a server route, and that is one experiment rather than a design
argument.
