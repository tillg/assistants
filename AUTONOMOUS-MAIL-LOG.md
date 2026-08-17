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

Filled in during the testing phase. See the bottom of this file.
