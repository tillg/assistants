# Autonomous run — the letterbox and the reader

Decisions and assumptions taken without the User present, while implementing
`specs/changes/receive-emails/` and `specs/changes/read-the-attachment/`.

Started 2026-08-17. Working alongside a second Claude session which owned
`bookkeeping-on-the-dashboard` (committed as `f8c69f9`).

---

## Decisions taken without asking

### D-M01 — Gmail reached over IMAP, not the Gmail API and not the `gog` CLI

The User confirmed mid-run that **Gmail is what the household uses**, and pointed at
`../wikai`, which solves the same problem with the `gog` CLI against the same account.

Taken: **IMAP**, with a Google App Password.

- `gog` is the right tool in the wrong process. `wikai` is a Claude Code session on a laptop
  shelling out to a Go binary that owns an OAuth keyring; this is a long-running Node service in a
  container. Adopting it means a Go binary in the image, its credential files, and a keyring
  password — `wikai`'s own CI needs `GOG_KEYRING_PASSWORD` for exactly that reason, and a container
  has the same problem a CI runner does.
- The Gmail API in Node is genuinely better on credentials (OAuth rather than an App Password) but
  costs a Google Cloud OAuth app, a consent flow, refresh-token storage in the container, and it
  binds the Connector to Gmail.
- **Gmail exposes every label as an IMAP folder.** So the label state machine — the thing worth
  taking from `wikai` — is available over a protocol that is not Gmail's. Swappable later; one file.

**Reversal cost: low.** The Connector boundary is the whole point; `connectors/email.ts` is the
only file that knows what IMAP is.

### D-M02 — Four folders, not two states

`wikai` runs `MailMem/{incoming,processed,failed}` and moves to `failed` on any handler error. My
first draft used the IMAP `\Seen` flag and had only two states, which is **wrong**: a message that
is fetched, allowed, and then fails must not stay unread (unread means *retry for ever*) and must
not be marked done (nothing was created).

Taken: `assistant`, `assistant/processed`, `assistant/failed`, `assistant/rejected`.

The fourth — `rejected` — is mine and not `wikai`'s, and it fixes a bug I introduced by adopting
only three. Disallowed senders originally stayed in `incoming`; since the poll takes at most
`MAIL_MAX_PER_POLL` messages, accumulated junk on a public address would eventually fill every poll
and starve a real invoice behind it. *"Not for us"* and *"we broke"* are different facts and must
not share a box.

### D-M03 — The label is `assistant`

Given by the User mid-run. Nested labels appear over IMAP with `/`, so the other three are
`assistant/processed`, `assistant/failed`, `assistant/rejected`. All four are configurable;
`MAIL_FOLDER_*` defaults to these.

### D-M04 — Missing folders are created, not fatal

The ingest calls `mailboxCreate` for all four on first poll and ignores "already exists". A missing
`failed` label at the moment something fails is the worst possible time to discover it.

### D-M05 — `MAIL_ALLOWED_SENDERS` empty means **nobody**

Not everybody. A mailbox is the first untrusted input this system has — every other route to a Thing
involves the User typing. A default that failed open on a public address would turn spam into
Conversations and LLM spend on the first day it was misconfigured. Startup logs the sender *count*
so a misconfigured `0` is visible rather than inferred.

### D-M06 — Config grouped as `Config.mail`, against the file's flat style

Ten flat `mail*` fields would be noise. The ingest takes the whole group as one argument, so the
grouping is what the code actually passes around. `visionMaxPages` / `visionMaxBytes` stayed flat —
two fields, two different callers.

### D-M07 — Which model reads a scan is **not** in `config.ts`

It is `llm.json`'s `vision` profile, for the same reason the active model is not an environment
variable: *"adding a profile means adding an entry here and one line to `.env`; nothing else in the
stack has to know its name."* Only the two caps are environment variables.

---

## Assumptions

| # | Assumption | If wrong |
|---|---|---|
| A-M01 | The household will create a Google **App Password** (requires 2FA on that account). IMAP with a normal account password is no longer accepted by Google. | Nothing works; the error is an auth failure at first poll, logged clearly |
| A-M02 | The Receptionist gets its **own** Gmail account, and the User forwards to it — rather than the system reading the User's own mailbox and filtering by label. Smaller grant: an App Password cannot be scoped, so the account it belongs to should contain only forwarded post. | The allowlist becomes unnecessary (a label the User applies cannot be applied by a stranger), but the system gains read access to the User's entire mail history. Worth revisiting with the User. |
| A-M03 | `MIN_TEXT_CHARS = 100` separates a real PDF text layer from scanner noise. Calibrated against generated fixtures, **not** against the household's real post. | Either a scan is treated as readable (bad — twelve characters of noise get classified) or a thin real invoice is sent to OCR (merely wasteful). Recalibrate against real post. |
| A-M04 | Vision reading is **unavailable by default**. `llm.json`'s `active` is `local_qwen`; no `vision` profile ships. | Nothing; the ladder falls through to `document.requestText`, which is today's behaviour |

---

## Notes for the review

- `.env` is **not** regenerated from `.env.example` — `scripts/setup-env.mjs` refuses to touch an
  existing `.env`. New variables were appended to `.env` by hand. Anyone cloning fresh gets them
  from `.env.example`; anyone with an existing `.env` will not.
- `npm install` of the three new dependencies reported **3 high severity vulnerabilities**. Audited
  below in the bug log; see B-xx.

---

## Bug log

Numbered `B-nn`. Every one was found while building rather than by the tests that were written
afterwards, which is worth noticing: none of them would have been caught by a green suite.

### B-01 — a new dependency shipped a high-severity advisory · FIXED

`mailparser` → `html-to-text` → `deepmerge-ts <8.0.0`, which has a stack-exhaustion advisory
(GHSA-ggr8-5vv4-36mx) when merging recursive object graphs.

`npm audit fix --force` would have **downgraded mailparser** to 3.9.8. Instead, an `overrides` entry
pins `deepmerge-ts` to `^8.0.0`, which resolves to 8.0.1 under an unchanged `mailparser@3.9.15`.
`npm audit` now reports 0 vulnerabilities, and the HTML-body tests still pass — which is what
actually proves the override is safe, since `html-to-text` is what mailparser uses to make
`text/html` readable.

Reachability was probably nil (the merge is over *formatter options*, not over anything from the
email), but shipping a new dependency with a high-severity advisory unexamined is not a thing to do
quietly.

### B-02 — git was silently rewriting the mail fixtures · FIXED

`.gitattributes` had `* text=auto`, so the eight `.eml` fixtures went into the object database with
**LF** line endings while the working copy kept **CRLF**. RFC 5322 specifies CRLF, and MIME boundary
detection and base64 decoding both read the exact bytes — so a fresh clone would have run the parser
against files that were not the ones the tests were written against.

Every test passed either way *on this machine*, which is exactly what makes it dangerous. Caught
only because git printed a warning during `git add`. Fixed with `*.eml -text` and `*.pdf -text`,
plus `git add --renormalize`.

### B-03 — the Runtime could not upload an attachment at all · FIXED

`import/auth/roles.yaml`: the `runtime` role had `DOCUMENT_CREATE`, `DOCUMENT_UPDATE`,
`DOCUMENT_PARTIAL_UPDATE`, `MODEL_READ` and `QUERY` — but **no `ATTACHMENT_UPLOAD`**, which both
`admin` and `user` have. Every forwarded invoice would have taken a 403 at the upload step.

Added. It is a *narrower* right than the ones already there — an attachment is content hung off a
Document the Runtime may already create — so it takes nothing back from D-007 or D-007a.

### B-04 — the server rejected every PDF · FIXED

`application-shared.properties`: `attachment.allowedMimeTypes=image/png,image/jpeg`. A forwarded
invoice is a PDF, so the entire feature would have failed at the first real message. The server
sniffs the true type from the bytes, so lying in the request would not have helped.

Added `application/pdf`. Kept as an allow-list rather than widened to a block-list.

### B-05 — SIGTERM was ignored for the whole of startup · FIXED

`runtime/src/index.ts` declared `stopping` and registered the `SIGTERM`/`SIGINT` handlers **after**
the "wait for the ThingStore" loop. So a Runtime asked to stop while still waiting had no handler
installed and no flag to consult once one was. On a cold stack the peer session measured it sitting
there **2.5 minutes**, ignoring the signal, until compose killed it — which reads in the log exactly
like a shutdown bug in the scan loop.

Pre-existing, and not strictly this change's business. Taken anyway: the letterbox makes startup
slower, so this would have been blamed on it.

Handlers now register before the wait, the wait checks `stopping`, and stopping there logs
"stopped while waiting for the ThingStore" rather than falling through to a bare "runtime stopped"
with no "connected" line above it.

### B-06 — the spec named the wrong upload route · FIXED (documentation)

`specs/changes/receive-emails/architecture.md` asserted the Runtime would write to `/cs`. `/cs` is
**download-only** (`/cs/download/<uuid>`) and is not even proxied for upload; the upload route is
`/api/v2/attachment`. Three further details were unguessable and came from reading the web
application's own uploader: metadata rides in the query string encoded exactly once, the body is raw
bytes, and the `Content-Type` is `application/json;charset=utf8` on a binary body because A12's
`HeadersFilter` replaces the header set wholesale.

Corrected in the spec rather than quietly fixed in code, because the staged Stage-A fallback the
spec described is now unnecessary and a future reader should know why.
