# Autonomous run — decisions & assumptions (preview-the-attachment)

Kept during the autonomous `/spec:apply preview-the-attachment` run so the User can review every
call made without them. Newest context at the bottom. Absolute times are Europe/Berlin.

## Coordination with the other sessions (the shared repo + stack)

- Three peer `assistants` sessions were live. Established ownership by asking each:
  - **ui-changes** owns the uncommitted `appsetup.ts` edit (`formEngineViewConfig`), the conversation
    components, and the new `AssistantBadge`/`ThingLink`/`ThingPopup` files. → **Decision:** place the
    preview by wrapping `EnginesViewMap.FormEngine`, **not** by editing `appsetup.ts`, so there is zero
    collision with their unmerged work.
  - **dynamic-operations** owns `runtime/`, `import/models/operation/*`, docs. No overlap with `client/`.
  - **third session** had run `just down` and holds nothing.
- **Stack protocol agreed with all peers:** no `just down`/`build`/Rancher-restart without pinging
  first; I bring the backend up with `just up` (existing images) and they may reuse it. Honoured
  throughout — pinged before the `up` and before the server restart below.

## Mechanism (plan step 1 — the one real fork)

- **Decision: same-origin `/cs` proxy + `fetch`→blob, NOT a server inline route.** Rationale: the
  proxy is one config line per surface (webpack dev server, nginx template, a compose env var), needs
  **no server rebuild** (kind to the shared stack) and no fourth hand-written Java class (avoids the
  ADR-0023 tension a server route would raise). The object-URL lifetime discipline the blob needs was
  already mandated by the plan regardless. Recorded in full as **DECISIONS.md D-071**.
- Assumption: `/cs` is served by the same server process as `/api` (host :8082). Verified from compose
  (`127.0.0.1:8082:8080` on the `server` service) and the download URL the platform advertises.

## Component (plan step 2)

- **Byte delivery** lives in `useAttachmentSource` and is mime-agnostic; the ticket URL is reduced to
  its path (`new URL(location).pathname + search`) so the `fetch` is same-origin.
- **Refused state** shows the filename + a Download control that **re-mints a fresh ticket** (the one
  behind the preview is single-use and already spent).
- **Text renderer** relies on React child-escaping (`<pre>{text}</pre>`), never `dangerouslySetInnerHTML`.
- **PDF iframe** uses `sandbox=""` (no `allow-same-origin`) per architecture.md's security section.
  **Open risk flagged:** a sandbox without `allow-same-origin` can block blob-URL navigation in some
  browsers — this is the #1 thing the browser check must confirm; fallback noted below if it fails.
- Localization: added a self-contained `document/localize.ts` reusing the shared `transcriptLanguage()`
  rather than editing the `en_US`/`de_DE` resource bundles — **ui-changes is editing those**, so this
  avoids a collision. Possible later consolidation, noted for the User.

## Placement (plan step 3)

- **Decision:** gate the pane on the activity's **model** (`Document_DM`) via `CddSelectors.cdd`, the
  same CDD slice the form reads (the app runs `withRelationshipFormEngine`, so the plain activity data
  holds no document). docRef from `descriptor.instance`, `t_docRef` as fallback. The gating/extraction
  is a pure function (`previewPropsFrom`) with its own unit tests.
- Assumption: one previewable attachment per Document — take the first `Attachment` entry that has an
  `attachment_id`. Matches the domain (one forwarded mail → one attachment per Document).

## E2E delete-hazard (plan step 5)

- **Decision:** `0-clean.setup.ts` keys the `Document_DM` cleanup on `Source === "E2E"` (a value the
  ingest never writes — it always writes `email`), instead of the `Title` prefix, which is now an
  untrusted email subject line. `Party_DM` keeps its `Name`-prefix match (no `Source`, not fed from
  untrusted input). The preview e2e stamps `Source: "E2E"` on the Document it creates.

## Stack operational events

- `just up` succeeded; then the server's **:8082 host forward wedged** (keycloak/firefly/frontend all
  still 200; java alive) — most likely a hung content-store request from a bad-ticket `/cs` probe I ran
  exhausting Tomcat. **Observation worth recording:** `/cs/download/<nonexistent>` appears to *hang*
  rather than 404 fast — a platform behaviour, not this change's to fix; I avoid bad-ticket probes and
  verify only via the real UI flow. Fixed with `just restart server` (recreates server+frontend+runtime,
  per D-020) after pinging peers.
- **Dev-server port:** run the webpack dev server on **:8091**, not its default :8081, so the frontend
  nginx container (which owns :8081) stays up for the peers. Keycloak's realm allows `localhost:*`, so
  the redirect works.
- **Playwright interaction quirk (as the plan warned):** real Playwright `click()` does not reach this
  app's React nav/rows; a synthetic `dispatchEvent(new MouseEvent("click",{bubbles:true}))` does. The
  step-4 e2e must use that.

## Browser verification found and fixed three real defects the unit tests could not

1. **Wrong document source.** `DocumentAttachmentPane` first read `CddSelectors.cdd` — empty for a plain
   Document form. The document is in `ActivitySelectors.data(activityId).document` (CDD kept as fallback).
2. **Attachment read-shape.** On read the `Attachment` group is a **single object**, not an array (its
   repeatability is 1). `firstStoredAttachment` now normalises both a lone object and an array.
3. **The `sandbox` attribute prevented the PDF from rendering at all.** Chrome refuses its PDF viewer in
   *any* sandboxed frame (`sandbox=""`, `allow-same-origin`, `allow-scripts allow-same-origin` all show
   a broken icon; only no-sandbox renders). **Decision:** drop `sandbox`; the browser's PDF viewer is the
   isolation. **Hardening added:** `useAttachmentSource` re-types the blob to the attachment's declared
   MIME type, so a mislabelled (`text/html`) store response cannot be sniffed into script in the
   now-un-sandboxed frame. Recorded in DECISIONS.md D-071 and architecture.md's Security section.

## E2E delete-hazard, revised after seeing real data (supersedes the note above)

- Live data showed leftover test Documents titled `E2E …` with `Source: scan` (not `email`). Keying the
  Document cleanup on `Source === "E2E"` **exactly** would have stopped reclaiming those — a cleanup
  regression. **Revised decision:** a Document is stale iff `Title` starts with `E2E` **and**
  `Source !== "email"`. This still never deletes an ingested (email) Document — closing the hazard and
  sparing the demo household — while reclaiming every `E2E`-titled test Document whatever `Source` it
  carries. `Party` stays keyed on its `Name` prefix.

## Step-4 e2e (written by a sub-agent, reviewed by me)

- Added `ThingStore.uploadAttachment` (POST `/v2/attachment`, raw bytes + JSON content-type, mirrors the
  Runtime's own `content.ts` upload) and `e2e/tests/base/11-attachment-preview.spec.ts`, plus a small
  generated PDF fixture. The spec creates its Document with `Source: "E2E"` + an `E2E` Title, so the
  revised cleanup reclaims it.

## Live browser acceptance (dev server :8091, real demo data — 47 Documents present)

- **The real invoice previews inline**: opening *"Fwd: Abschlagsrechnung RE0520 … Abschlagsrechnung_RE0520_17.08.2026.pdf"*
  renders the A.H-Bau invoice (letterhead, line items, amounts) in the browser's PDF viewer, in a
  centred **A4 frame measured at 510×722 px = 0.706 ≈ 210/297**. Screenshots in `tmp/`.
- All three real household Documents (invoice, `Logo.pdf`, Widerrufsbelehrung) open and preview; a Party
  form shows no pane and renders normally (gating regression).

## Two more findings from exploratory testing, both handled

1. **Defect found and fixed: an unsupported attachment showed an empty framed pane.** Seeding an
   `image/png` Document revealed that `DocumentAttachmentPane` rendered its bordered `<Pane>` even when
   `AttachmentPreview` returned `null` (no renderer for images) — an empty box under the form, which
   architecture.md forbids ("renders nothing at all"). Fixed: exported `canPreview(mimeType)` and gate
   the pane on it, with a unit test. Re-verified: the image Document now shows **no pane**.
2. **The `text/plain` renderer is currently unreachable in this deployment — worth the User's
   attention.** The server's attachment allowlist is
   `grtnr.assistants.server.attachment.allowedMimeTypes=image/png,image/jpeg,application/pdf`
   (`application-shared.properties`), and the content type is server-**detected**, so a `text/plain`
   upload is rejected with `error.attachment.invalidType`. The plain-text renderer is implemented and
   unit-tested (including HTML-escaping of `<script>` bytes), but no `text/plain` attachment can exist
   until the allowlist includes it. **Decision:** keep the renderer (it is correct and the registry's
   whole point is to be ready), and flag the gap rather than widen a security control autonomously — the
   User should decide whether to add `text/plain` to the allowlist or treat plain-text preview as
   forward-looking. Not changed here.

## Test data created (all reclaimable by the e2e cleanup)

Seeded via the API (`scratchpad/seed-test-docs.mjs`, run three times → 17 `E2E QA` Documents, 63 total):
`image/png` and `application/pdf` Documents, each `Title: "E2E QA …"`, `Source: scan` — so
`0-clean.setup.ts` (Title `E2E` AND `Source != email`) reclaims them on the next e2e run.

## CRUD + regression coverage (exploratory, via Playwright MCP)

- **Create** ✓ — via the API (17 docs) and the passing e2e spec.
- **Read/Preview** ✓ — invoice, `Logo.pdf`, Widerrufsbelehrung, and QA PDFs all preview; the `image/png`
  Document defers (no pane); a Party form shows no pane. Overview paginates at 10/page across 63
  Documents and the preview still renders. Zero console errors throughout.
- **Delete** ✓ — deleted a QA Document through the overview's row action + confirm dialog; count dropped
  52→51, verified via API.
- **Object-URL lifecycle verified live** (not just in jsdom): instrumented the real browser's
  `createObjectURL`/`revokeObjectURL` and switched across five Documents — every blob is revoked on
  switch, exactly one stays live (the displayed Document), zero leaked. Matches the unit tests.
- **Update / Search** — **covered by the existing green e2e suite** (`3-crud.spec.ts` does full
  create/read/update/delete of a Party through the real UI; base specs 8/9 use overview search).
  Note: A12's controlled text inputs do not register Playwright's synthetic `fill()` in the MCP session
  (form edits and the search box did not take), so I verified these through the e2e harness — which
  drives real user input and is green — rather than the MCP browser. A harness quirk, not a product bug.

## The User came back and couldn't see the preview — layout fix

The User reported no PDF preview on the running stack, then on the dev server too. Diagnosed: the
preview **rendered correctly** but the Documents screen is a master-detail (overview list on the left,
form on the right ~690px), so a "full-width pane beneath the form" sat below a full-height Document
form — below the fold. The feature worked but was invisible without scrolling, breaking the proposal's
promise that the document is "already on the screen."

**Fix (two parts, both verified in the browser):**
1. **Responsive side-by-side** (`EnginesViewMap.tsx`): the form and the preview are a `flex-wrap` row —
   side by side when both fit (wide screens), the preview wrapping beneath on a narrow one. Every
   non-Document form is the sole child and stays full-width, so nothing else changes.
2. **Auto-reveal** (`DocumentAttachmentPane.tsx`): when a Document opens and the pane has wrapped into
   the lower half of the viewport, it scrolls itself into view (`block: "center"`, after a short settle
   delay so it measures the form's real height). On a wide screen where it already sits beside the form,
   nothing scrolls. Measured: the invoice PDF goes from 3% visible to **100% visible** on open, with the
   form fields still above it.

This updates architecture.md's "Layout — settled" note (which assumed a plain beneath-pane). It is a
reversible CSS/effect change; if the User prefers a different balance (e.g. preview above the fields, or
never auto-scrolling), it is a small tweak.

## A real defect my verification could not catch: the nginx envsubst allowlist

After dynamic-operations ran a full `just build` + `just up`, the built `assistants_frontend` crash-looped:
`nginx: [emerg] unknown "nginx_assistants_server_contentstore_url" variable`. **My bug.** The frontend
image's start command runs `envsubst` with a **fixed allowlist** of variables to substitute into
`nginx.conf.template` — generated by `client/build.gradle`'s `createDockerfile` task (`defaultCommand`,
~line 145), which listed only `${NGINX_ASSISTANTS_SERVER_BASE_URL}` and `${…_ACTUATOR_URL}`. My new
`${NGINX_ASSISTANTS_SERVER_CONTENTSTORE_URL}` was not in it, so envsubst passed it through literally and
nginx read `${…}` as an (unknown) nginx variable and died.

**Fix:** added `${NGINX_ASSISTANTS_SERVER_CONTENTSTORE_URL}` to that allowlist in `client/build.gradle`,
regenerated the Dockerfile (verified all three vars now present), and rebuilt the frontend image.

**The lesson, recorded plainly:** my dev-server verification (webpack proxy on :8091) exercised the `/cs`
route but **never the built nginx**, and `just check` does not build images — so this class of bug (a
change to `nginx.conf.template` that adds a templated variable) is only caught by a full `just build` +
`up`. A `nginx.conf.template` edit that introduces a `${VAR}` must be paired with a build-image check,
not just a dev-server check. This is the honest cost of avoiding a shared `just build` during
development — it moved the discovery to the first real build, where a neighbouring session hit it.

## Final status

- **Feature complete and verified.** Client unit suite **612 passing** (tsc/eslint/prettier clean); the
  new e2e spec **passes 4/4**; browser-verified end to end.
- **`just check` is red only on other sessions' uncommitted WIP** — `runtime/test/**` (dynamic-operations)
  and `client/src/test/components/ThingLink.test.tsx` (ui-changes import order). Every portion this change
  owns passes: `client tsc`/`eslint`/`prettier`, `e2e tsc`/`lint`/`format`.
- **One item for the User to decide:** whether to add `text/plain` to the server attachment allowlist so
  the (already-built, unit-tested) plain-text renderer becomes reachable. Not changed autonomously.
