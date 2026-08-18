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

- [ ] **Try proxying `/cs` through nginx** — one line in `compose/docker-compose.yml`, which is
      currently `/api` and `/actuator` only. That makes the download same-origin and dissolves CORS.
      **Inferred from the compose file, not tested — test it.** It does *not* fix the disposition
      header, so a blob URL is still needed
- [ ] **Otherwise: a same-origin authenticated route on the application server** that reads the
      attachment and re-serves it `Content-Disposition: inline`. Prefer this shape over returning bytes
      for a blob, because there is then no object-URL lifetime to get wrong
- [ ] **Verify** whichever is chosen with a real PDF rendered in a real browser before building the
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

- [ ] Tests for the three states, before the component:
  - a PDF attachment renders a frame with an object URL
  - a non-PDF `mimeType` renders **nothing at all** — not an empty frame, not a placeholder
  - a failed fetch renders the filename and a download link, i.e. degrades to today's behaviour
  - the object URL is **revoked on unmount** and on `attachmentId` change. Assert it: a leaked 175 KB
    blob per Document view is invisible until a long session
- [ ] Implement `client/src/components/document/AttachmentPreview.tsx`, fetching by whatever step 1
      established, and **not** by a hand-rolled token fetch
- [ ] `sandbox` the iframe with no `allow-same-origin`
- [ ] **Verify:** `cd client && npx tsc --noEmit && npm run lint` and the component tests pass

## 3. Put it in the form

- [ ] Place it via the application rather than a Form Engine `WidgetMap` entry, per
      [architecture.md](architecture.md#where-it-hangs-in-the-form)
- [ ] Decide the height question deliberately — a frame too short previews a letterhead, which is the
      one part of an invoice carrying no information. Look at it in the browser before choosing
- [ ] **Verify in the browser:** open the real invoice and read `Gesamtbetrag 3.570,00` off the
      preview. Then open the `Logo.pdf` Document and confirm it is visibly a logo. That pair is the
      whole point of the feature and it is the acceptance test
- [ ] **Verify:** an image attachment still previews as A12 previewed it, and upload / replace / delete
      still work

## 4. End to end

- [ ] One e2e that opens a Document with a PDF and asserts the preview is present.
      **Create its own Document with an `E2E`-prefixed Title** so `0-clean.setup.ts` reclaims it, and
      do not rely on the real invoice being there
- [ ] **Watch `7-forms-open.spec.ts`.** It asserts a row opens without a post-processing error and a
      Document form is in its path; it already failed once under parallel load. If it goes red, check
      whether it is this component or the store being slow before concluding the former
- [ ] **Verify:** the suite is green, and take a baseline first so "green" means something

## 5. The hazard found while planning this — fix or record

Independent of the preview, and found by the neighbouring session: `0-clean.setup.ts` identifies its
own data by a `Title` prefix, and since the letterbox, `Title` is **the subject line of an email**.

- [ ] A forwarded mail whose subject begins `E2E` would be **silently deleted** by the next e2e run.
      Untrusted input meeting a delete, which is the combination worth not leaving alone
- [ ] Decide and do one of: scope the cleanup by something the ingest cannot produce (`Source` is
      `email` for every ingested Document, and `E2E` for none); or have the ingest guarantee the
      prefix cannot occur. **Prefer the first** — the cleanup should not delete Things it did not
      create, and that is true regardless of what any subject line says
- [ ] **Verify:** create a Document titled `E2E test` by hand and one titled `E2E…` via the ingest,
      run the setup, and confirm only the first is deleted

## 6. Documentation

- [ ] `specs/system/functional.md` — the Document form previews a PDF attachment
- [ ] `README.md` only if the "In"/"Out" tables are affected. They probably are not
- [ ] `DECISIONS.md` — the step 1 answer, which is the whole value of this change's investigation:
      what the download route actually is, and whether the platform's own was broken here
- [ ] **No ADR.** No decision of that weight: A12 previews images, we want PDFs, the browser has a
      viewer. If step 1 lands in world (b) and the fix is to move where content is stored, **that** is
      an ADR, and a serious one

## 7. Close out

- [ ] `just check`
- [ ] Re-read the diff: no Runtime change, no Model change, no new Operation, no new Skill
- [ ] Confirm the User's three real Documents are still in the store and still openable

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
