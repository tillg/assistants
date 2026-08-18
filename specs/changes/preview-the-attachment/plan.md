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

## 1. Settle how the bytes are fetched — **in a real browser**

The one step that can invalidate the design.

- [ ] Drive the running application: log in, open the Document
      `Document_DM/119f03d5-8281-4ec8-89ca-ea817d9e9ea4`
      (*Fwd: Abschlagsrechnung RE0520 … — Abschlagsrechnung_RE0520_17.08.2026.pdf*)
- [ ] Record **every** network request made while opening it and while interacting with the attachment
      field. The browser's own request is the only reliable witness — it was for the upload route,
      where the documentation was wrong
- [ ] Try the download action. Capture method, URL, auth mechanism, status, content-type, size
- [ ] Note what the field renders for a PDF today: icon, filename, thumbnail, any download affordance
- [ ] Compare against an attachment **not** uploaded by our Runtime — create a scratch Document, upload
      a small PNG through the UI, download it, then delete the scratch Document. If the browser's own
      upload downloads and ours does not, the fault is in our upload
- [ ] **Verify and record which world we are in:**
  - **(a) the browser can download ours** → continue at step 2 as proposed
  - **(b) it cannot** → this becomes a bug fix first. Go to step 1b, and tell the User: every
    attachment the mail ingest has stored is unreachable from the application, which is a bigger fact
    than a missing preview

## 1b. Only in world (b) — restore downloading

- [ ] Establish whether `LOAD_ATTACHMENT_URL` can ever resolve under
      `contentstore.storage.content-storage=db`, or whether it requires `cs`
- [ ] **Do not change `content-storage` casually.** It decides where every existing attachment lives;
      flipping it may orphan what is already stored. Establish what happens to existing rows *before*
      proposing it, and say so explicitly
- [ ] If the fault is instead in our upload — a missing field, a step the browser performs and we do
      not — fix `runtime/src/a12/content.ts` and re-ingest the real mail to prove it
- [ ] **Verify:** the download action works in the browser for a Runtime-uploaded attachment. That is
      the gate; the preview is worthless without it

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
1. browser: how do we get the bytes?
   ├── (a) we can  ──────────────► 2. component ─► 3. in the form ─► 4. e2e ─► 6. docs ─► 7. close
   └── (b) we cannot ─► 1b. fix downloading ─┘
                        (may be an ADR, and affects every stored attachment)

5. the E2E-prefix delete hazard — independent, do it whichever world we are in
```

Step 1 is the only step that can tell us something we do not know. Everything after it is bounded
work, and step 5 is worth doing even if the preview is abandoned.
