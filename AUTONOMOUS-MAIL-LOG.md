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

### B-07 — the allowlist was checked after the message was fully parsed · FIXED

`handleMessage` called `parseMessage` and *then* `isAllowedSender`. So a message from a total
stranger was fully MIME-parsed and its attachments base64-decoded into memory before the gate said
no. At `MAIL_MAX_PER_POLL = 20` and `MAIL_MAX_ATTACHMENT_BYTES = 25 MB` that is up to half a
gigabyte of decoding per poll done on behalf of senders nobody vouched for — in the process that
runs the scan loop.

**Authorise first, parse second.** `FetchedMessage` gained an `envelopeFrom` taken from IMAP's
`ENVELOPE`, which needs no body parse, and the gate now runs on that before `parseMessage` is
called. The post-parse check on the `From:` header stayed as a second, cheap assertion: the envelope
sender and the header sender can differ, and the stricter reading — both must be allowed — is the
right one for a gate.

### B-08 — the ingest never read the text layer on arrival · FIXED

`specs/changes/receive-emails/architecture.md` requires the ingest to call `extractText` between
uploading the attachment and creating the Document, so the Receptionist is triggered by a Document
that is already classifiable. It did not, so every forwarded PDF — including the born-digital ones,
which are most of them — would have cost a wasted Turn to discover it had no text, and then a
question to a human who need never have been asked.

A missing feature rather than a defect in what was written, and it would not have failed a single
test: everything downstream handles an empty `extractedText` correctly, because that is the state
the ladder is built around. It would have shown up only as a system that was quietly more expensive
and more annoying than it needed to be.

### B-09 — the `email.receive` kill switch did nothing · FIXED

The catalogue's `Enabled` flag is how the User switches an Operation off from the web application,
without a restart ([ADR-0019](docs/adr/0019-an-operation-is-a-thing.md)). The ingest never read it,
so switching `email.receive` off changed nothing at all and the letterbox went on collecting post.

Worse than a missing feature: a control that appears to exist, is documented to exist, and silently
does not. The one thing a kill switch may never be is decorative.

### B-10 — the registry documents a safety check it does not implement · OPEN

`runtime/src/operations/registry.ts` states, in its file-level comment:

> **The idempotency contract**: every Operation is either read-only or idempotent under a
> caller-supplied key. No Operation may be both mutating and unkeyed. `mutating: true` without a key
> argument is a programming error and **throws at registration**.

`register()` implements no such check. It throws on a duplicate name and nothing else. So the
sentence is false, and has been since it was written.

Found by an agent that complied with the contract, expected registration to fail when it
deliberately did not, and looked to see why. Nothing currently violates the contract — every
mutating Operation does take a key — so there is no live defect, which is exactly why it survived:
a rule nobody breaks is a rule nobody notices is unenforced.

**Left open deliberately.** Implementing it means deciding what counts as "a key argument" for
every existing Operation, and doing that at the end of a long autonomous run — in a file that
currently carries uncommitted work from two sessions — is how a safety check becomes an outage. It
is a small, well-understood change and it should be made deliberately, with the suite watched. The
alternative fix, weakening the comment to match the code, would be the wrong way round: the comment
describes the property that is actually wanted.

### B-11 — the e2e suite was testing whichever application answered first · FIXED

Found by the parallel session, fixed here. `e2e/utils/config.ts` defaulted all four service URLs to
`localhost`. Compose binds every published port to `127.0.0.1` — IPv4 only — and macOS resolves
`localhost` to `::1` first. So **any process holding the IPv6 wildcard on one of those ports shadows
the container**, and the suite silently tests it instead.

Not hypothetical. A webpack dev server left listening on `*:8081` since that morning meant
`localhost:8081` answered from a live-compiled bundle while `127.0.0.1:8081` answered from the image
`just build` had produced. Two applications, one URL, and the peer session established it by reading
six healthy tiles and then screenshotting a "Failed to compile" overlay two seconds later.

The failure mode is both silent and flattering: the suite passes, and what it passed against is not
what ships. All four URLs were vulnerable, not only `BASE_URL`; 8081 was simply the one with a
squatter. The reason is written next to the value, because a bare `127.0.0.1` reads like a style
preference and will eventually be tidied back into `localhost` by somebody being helpful.

`e2e/build.gradle:47` hardcodes the same thing and was **left alone** — it belongs to the other
session's tier and was mid-run.

**The dev server was not killed.** It had `PPID 1` and a start time thirteen hours before either
session began, which makes it the User's own process. Two agents agreeing to kill a human's
long-running process at midnight is not a call either of them should make, and the config fix
removes the problem without touching it.

---

## Second pass — an adversarial review of the finished change

The eleven above were found by building. These twelve were found by an agent whose only instruction
was to assume the code was wrong and try to prove it, with throwaway probe scripts rather than
argument. Most are reproduced. Two of them lose an invoice.

That is the lesson of this run, stated once: **the suite was green at 343 tests before this review
started, and stayed green through every finding.** Tests pin the behaviour you thought of.

### B-12 — part numbering shifts when an attachment is skipped, losing an invoice · REPRODUCED · FIXED

`connectors/email.ts`. `externalRef` was `#<index+1>` over the *kept* attachments, so the size cap
changed the numbering of everything behind it:

```
cap=1000    <m1@example.com>#1 = small.pdf
cap=100000  <m1@example.com>#1 = big.pdf   <m1@example.com>#2 = small.pdf
```

The failure is exactly the case the feature exists for. A mail arrives with `big.pdf` (over the cap)
and `small.pdf`; `small.pdf` is filed as `#1`. The User raises `MAIL_MAX_ATTACHMENT_BYTES` and moves
the mail back to `assistant`. Now `big.pdf` *is* `#1`, so the ingest finds it already present and
skips it — **the invoice is never ingested** — while `small.pdf` has become `#2`, which does not
exist, so it is created a **second time**. One lost invoice, one duplicate, and the message moves to
`processed` looking like a success.

The reference for a MIME part must not depend on a configuration value.

### B-13 — a successful message was filed as a failure · REPRODUCED · FIXED

`watcher/mail.ts`. The final `move` sat inside the same `try` as the ingest, so a transient IMAP
error on the last statement — after every Document had landed — put the message in
`assistant/failed` and counted it failed. Worse than wrong: it is not self-healing, because the
message is no longer in `incoming`, so it sits in a human's failure inbox for ever for a poll that
actually worked.

The file's own comment described the correct design. The code did not implement it.

### B-14 — a rejected message was filed as a failure, and counted twice · REPRODUCED · FIXED

Same cause. One hiccup moving to `rejected` and a stranger's mail landed in the folder reserved for
*"we broke"* — collapsing the *"not for us"* / *"we broke"* distinction that the four-folder design
is entirely about — and the same message was counted in both `summary.rejected` and
`summary.failed`.

### B-15 — the size cap bounded nothing that mattered · REPRODUCED · FIXED

The cap was applied *after* mailparser had decoded every part. Measured: a 30 MB attachment against
a 1 MB cap parsed in **9.4 seconds** and cost **255 MB of RSS** — and was then discarded. `fetch`
also buffered every raw message before parsing any, so the worst case at the defaults was ~700 MB
held at once and ~188 s of synchronous CPU, in the single-threaded loop that also runs the seven
ThingStore scans. `health.ts` calls the Runtime stale after 90 s, so an ordinary spam batch would
have reported the whole system **unhealthy**.

It also falsified a comment written in this run: the envelope check does avoid the *decode*, but the
raw bytes were already in memory before it ran, and the raw is the larger of the two.

### B-16 — the 100-character threshold misclassified real invoices · REPRODUCED · FIXED

Measured against realistic born-digital PDFs: a short dentist invoice at **84** characters, a
one-line payment reminder at **44**, a parking receipt at **49** — every one reported
`no-text-layer`, and `document.extractText`'s own description then tells the model to spend money
reading it with `document.readScan`.

So the change's central economic argument **inverted**: money spent on a model that can invent an
amount, to read a document whose amount was free and exact. The original calibration — 21 characters
against 576 — was honest arithmetic against a population of two.

The fix is not a different number. It is to stop discarding the text: report that it is sparse and
hand it over, and let the Receptionist judge. Deciding whether eighty-four characters are an invoice
or a scanner artefact is judgement, and this system's whole argument is that judgement belongs to an
Assistant rather than to a constant in a library.

### B-17 — the watcher's once-per-outage suppression was dead code · FIXED

`runMailIngest` caught everything and returned a summary, so the `mailboxFailing` state in
`watcher.ts` was unreachable and a mailbox that was down logged an error **once a minute, for
ever** — precisely the flood the suppression was written to prevent. A test pinned the swallowing,
which is how it survived.

### B-18 — SIGTERM cannot interrupt a mail poll · PARTLY FIXED

The stop flag is only read between scans, and a poll can exceed Docker's 10 s default grace, so the
container was SIGKILLed mid-pass — possibly mid-upload. `stop_grace_period: 60s` is set. Threading
an abort signal into the ingest so a stop is honoured *within* a poll is the remaining half.

This is the same defect class as B-05, which this run had already fixed for startup — found again
one layer down.

### B-19 — a vision profile's provider was ignored · FIXED

`createVisionReader` always built the Anthropic reader. An `openai` profile named under `vision`
would start cleanly, log `provider: openai`, and then POST Anthropic-shaped JSON with an `x-api-key`
header to an OpenAI endpoint. Every read fails and the log says the opposite of what is happening,
which sends whoever debugs it to the wrong place.

### B-20 — negative token counts were accepted · FIXED

`Number.isFinite(-999999)` is true, so an Operation returning a negative `usage` **subtracted** from
the Turn's recorded cost, falsifying the lower-bound property `CONTEXT.md` builds on. D-054
explicitly supports pointing a profile at a local server, which is where an odd `usage` block is
most likely to originate.

### B-21 — one IMAP login per moved message · FIXED

Every public method opened, authenticated and closed its own connection: one poll was
`2 + N` logins. At `maxPerPoll = 20` that is 22 TLS handshakes a minute against Gmail, which
throttles rapid reconnects — and 20 handshake-plus-login latencies inside the scan loop.

### B-22 — `extractedText` was unbounded · FIXED

Capped nowhere: not in the connector, not in the ingest, not in the Model. A forwarded 500-page PDF
would be extracted in full inside the scan loop, stored whole, and then loaded into the
Receptionist's prompt on the next Turn, where it is paid for by the token. Every other field written
by the ingest is capped at 200.

### B-23 — the synthesised message id drops the mailbox identity · FIXED

A message with no `Message-ID` got `<uid.N@local>`. IMAP UIDs are unique only within one
`(mailbox, UIDVALIDITY)` generation, and `@local` is a constant — so deleting and recreating the
`assistant` label restarts UIDs at 1, and a later message can compute a reference an earlier,
different message already holds. The ingest then skips it as a duplicate and moves it to
`processed`: **a silently dropped invoice, counted as `skipped`.**

The spec said `<uid>@<mailbox-host>` and gave the reason — *"the UID is stable within a mailbox"*.
The code dropped the half that made the sentence true.

### Categories the review could not break

Worth recording, because a clean result only counts if it was genuinely attacked.

- **The sender allowlist.** Seventeen hostile inputs — uppercase, surrounding whitespace,
  `"user@example.com" <attacker@evil.com>`, two `<>` pairs, nested `<<…>>`, a trailing dot,
  `undisclosed-recipients:;`, an empty envelope, `user@example.com.attacker.io`, Turkish dotted-İ,
  Kelvin-sign case folding — all correctly refused or correctly allowed, and IDN mismatches fail
  **closed**. The residual weakness is architectural rather than a defect: an attacker who forges
  both the SMTP envelope and the `From:` header passes both checks, so the gate ultimately rests on
  Gmail's SPF/DKIM enforcement at the edge.
- **Refusal before spend.** Both readers refuse a non-empty `extractedText` before anything is
  downloaded and before any vision call; whitespace-only counts as empty; `replace: "false"` is not
  truthy.
- **Turn cost attribution.** `costEntry` is the right Entry on every path traced, including several
  tool calls in one Turn and the unresolved-call branch.
- **MIME nesting.** 50, 500 and 2000-deep nested multiparts parsed in under 100 ms without throwing.

## Third pass — against a real IMAP server

The IMAP half had never touched a server; every ingest test used an in-memory fake. Twelve
integration tests now run against a real GreenMail instance in a throwaway container
(`test/integration/mail-imap.itest.ts`, outside the unit tier).

**The real server agreed with the fake on every behaviour the fake asserts.** No defect in
`EmailConnector`. What the exercise did surface:

- **`/` is a Gmail assumption.** GreenMail's hierarchy delimiter is `.`, so `assistant/processed` is
  not a child of `assistant` there — it is one flat mailbox whose name contains a slash. Harmless
  here, because neither the connector nor the ingest ever asks about hierarchy: the four names are
  opaque strings passed to `CREATE`/`SELECT`/`MOVE`. On Gmail they are a label and three sub-labels;
  elsewhere they are four siblings. A server that *rejects* `/` in a mailbox name would break, and
  nothing detects that.
- **A move to a missing folder succeeds**, because `move` creates the destination first. Without
  that the server answers `NO [TRYCREATE]`.
- **UIDs are the server's and change on a move** — which nothing depends on today, but a future
  "look it up again in `processed` by UID" would pass against the fake and fail for real.
- One test-only field was added: `secure?: boolean`, defaulting to `true`, set to `false` only by the
  integration tier. Trusting GreenMail's certificate is impossible — it has no SAN — and the
  alternative, a `tls` passthrough, is the option that ends up in production with verification
  quietly off while still looking encrypted. `secure: false` is plaintext, obvious and greppable, and
  the file's invariant stays literally true: there is still no way to have TLS and skip verification.

### B-24 — my own fix for B-11 was half wrong, and running it is what showed that

Recorded because it is the most useful finding of the night about how the other twenty-three were
found.

B-11 moved all four e2e URLs from `localhost` to `127.0.0.1`. The reasoning was right and the
diagnosis was right. Two of the four changes broke authentication outright, and I did not know
because I reasoned about it instead of running it. The parallel session ran it and measured:

- **`BASE_URL`** — `a12-spa-client` in the realm allows `http://localhost:*` as a redirect URI and
  nothing else, so a browser sent to `127.0.0.1:8081` is bounced by Keycloak with *"Invalid
  parameter: redirect_uri"* before it ever reaches the application.
- **`KEYCLOAK_URL`** — `KC_HOSTNAME` pins the issuer to `KEYCLOAK_PUBLIC_URL`, so the browser lands
  on `localhost:8089` whatever is asked for, and the auth setup waits thirty seconds for a
  navigation that never comes.

`THINGSTORE_URL` and `FIREFLY_URL` keep `127.0.0.1`: bearer-token APIs, no redirect, no issuer to
match. The realm template now also allows `http://127.0.0.1:*` — but a realm is imported once, so it
only takes effect after `just clean`.

**The pattern worth keeping:** every defect in this log was found by building, reading or attacking.
This one was found by *running*, and it is the only one that was a mistake in a fix rather than in
the original. A change that is right in principle can still be wrong in a way only the stack can
tell you — and the two URLs that had to stay `localhost` are exactly the two whose value is baked
into something outside the file being edited.

---

## Fourth pass — the first real email

The User created the Gmail label, forwarded a real builder's invoice, and asked why it was not in the
system. It was not in the system because nothing had ever been stored. Three defects, found in the
order a real message meets them.

### B-25 — every real email failed to store · REPRODUCED · FIXED

`Document_DM`'s `ReceivedAt` is a `DateTimeType` formatted `yyyy-MM-dd'T'HH:mm:ss` — **no
milliseconds, no zone**. The Connector reports an ordinary ISO 8601 instant, which has both, so the
store refused every Document with *"the given value is not valid for type date representation"* and the
message went to the failed folder.

The normalisation already existed in the file. It was applied only to the fallback, never to the value
used in practice.

**How it survived 383 green tests.** The assertion covering that field read:

```ts
expect(document?.data.receivedAt).toBe("2026-01-13T17:02:11.000Z");
```

— the exact value no A12 server accepts. Written from what the code *did* rather than from what the
Model *declares*, and the in-memory store the unit tests write through does not validate formats. The
test now also pins the shape with a regex, so the format cannot drift back.

Note what the failure handling did while this was broken: counted the message failed, moved it to
`assistants/failed`, carried on. That part behaved exactly as designed.

### B-26 — the covering note was hiding the invoice · REPRODUCED · FIXED · **my error**

Reading the attachment's text layer happened only when the mail body was empty. The stated reasoning
was that a forward's covering note is context the Receptionist wants and must not be overwritten. The
first half is right; the conclusion was wrong. **Almost every forward has a covering note**, so in
practice the invoice was never read at all.

Measured on the real message: three attachments, a 568-character note, and a Document carrying
*"Begin forwarded message: From: Andreas Herescu…"* and not one figure from the invoice. The
Receptionist could not have extracted an amount from it, which is the entire purpose of the exercise.

This one is mine rather than an agent's: it is what the brief I wrote asked for, in those words. The
test that covered it asserted `not.toContain("Rechnungsnummer")` — it *required* the invoice to be
absent — so the specification and its test agreed with each other and both were wrong.

Now both, joined, with the attachment's text under a `--- filename ---` heading. The same invoice went
from 568 characters to 1475, and `Rechnungsnr. RE0520` with `Gesamtbetrag 3.570,00` is in the field the
Accountant reads. The heading is not decoration: three PDFs in one message would otherwise leave the
model guessing which text belonged to which file.

### B-27 — three attachments read as three copies · FIXED

The User's reasonable conclusion from the overview was *"it's in three times, we need a dedupe"*. The
dedupe was working: three different files, three different refs, and a second poll against the live
store created nothing and skipped three. **Only the title collided** — all three read
`Fwd: Abschlagsrechnung RE0520 von A.H-Bau` — and a title is what a human identifies a Thing by.

So the data was right and the presentation lied. The filename now joins the title as soon as one
message becomes more than one Document; a single attachment keeps the bare subject. And again the test
had pinned the confusion in place, asserting both titles were *identical*.

Worth separating from a real gap, which remains open: the dedupe is keyed on `Message-ID` plus MIME
part, so **forwarding the same invoice twice creates a second set of Documents** — Gmail mints a new
`Message-ID`. Catching that means comparing content rather than identifiers, which is judgement, and
belongs where the other judgement went.

### B-28 — the e2e cleanup deletes Documents by a title prefix, and titles are now untrusted · OPEN

Found by the parallel session. `e2e/tests/base/0-clean.setup.ts` deletes `Document_DM` Things whose
`Title` starts with `E2E`, and it runs as a setup dependency of essentially every e2e run — it reported
deleting a leftover Document during last night's runs, so it is live.

Since the letterbox, `Title` is **the subject line of an email**. A forwarded mail whose subject begins
`E2E` would be silently deleted by the next test run. Untrusted input meeting a delete.

**Left open**, with a recommendation rather than a patch: scope the cleanup by something the ingest
cannot produce — `Source` is `email` for every ingested Document and `E2E` for none — rather than
constraining what subject lines the household is allowed to forward. A cleanup should not delete Things
it did not create, and that is true regardless of what any subject line says. It is in the preview
change's plan as step 5, because it wants doing whichever way that change goes.

## Corrections to this log

Two claims made in it were wrong, and both were corrected by running something rather than reasoning
about it. Recording them because the pattern is the most useful thing here.

### C-01 — "the platform's attachment download is broken" · WRONG

Asserted, with a measurement to back it: `LOAD_ATTACHMENT_URL` answering *"No URL from attachmentId …
could be found"*, blamed on `contentstore.storage.content-storage=db`, and concluded that every
attachment the mail ingest had stored was unreachable from the web application.

All false. The `attachmentId` and `docRef` were **stale** — I had deleted and re-ingested those
Documents myself an hour earlier while fixing B-25, then diagnosed a platform fault from identifiers
that no longer existed. Side by side against the live server, the stale pair reproduces the error and
the current pair returns a location. `content-storage=db` is a red herring; the content store issues
tickets regardless of where bytes are persisted.

The measurement was real. The thing measured was not what I thought it was.

### C-02 — "the single-use download ticket is an obstacle" · WRONG

Listed as one of four obstacles to a preview. It is not an obstacle; it is a sound design, and the
User's pushback — *"if I upload a doc, I must get a handle to download it, no?"* — was the correct
reading.

You do get a handle: `attachment_id`, on the Document, durable and reusable without limit. The ticket
is a one-shot redemption of it. Verified with the same handle throughout: two mints give two different
URLs, each fetches the full 175362 bytes, and replaying a spent one answers 404.

And the reason is good. `/cs/download/{id}` is unauthenticated by design, so a permanent URL for a
household invoice would leak for ever — browser history, proxy logs, a `Referer` header, a shared
screenshot. Single-use makes a leaked URL worthless within moments, and the authentication happens at
the mint step against the User's own token.

Of the four obstacles that draft listed, only two block anything: `Content-Disposition: attachment` and
CORS.

---

## Fifth pass — the container, and Gmail for real

### B-29 — a Conversation that reaches 100 Entries can never be advanced again, and retries for ever · REPRODUCED · OPEN

Found by watching the rebuilt Runtime's own logs, not by any test.

`Conversation_DM`'s `Entries` group has **`repeatability: 100`**. The Loop Driver appends Entries
without bound — a prompt, an LLM response, a tool intent, a tool result, an error — and an Assistant's
`maxTurns` is **20**, so a Conversation that uses several Entries per Turn passes 100 long before it
runs out of Turns. When it does, every write fails:

```
MODIFY_DOCUMENT failed … The index for group '/Conversation/Entries' was specified with 101,
but at most 100 is allowed.  ErrorCode: zuGrosseKontextnummer
```

It is not a one-off failure. The Conversation cannot be written, so it cannot be marked failed, so it
stays runnable, so the scan picks it up again — **once every ~7 seconds, indefinitely**. One such
Conversation (`db637140-…`, from another session's bookkeeping tests) was doing exactly that on this
machine, and it is the only thing in the log that is throwing.

**The failure mode is the bad one.** The two caps disagree with each other: `maxTurns` is the one
written down and reasoned about, and `Entries` is the one that actually binds. Nothing checks the
second, and the error surfaces as an A12 validation message about row numbers rather than as
*"this Conversation is full"*.

**Left open, deliberately.** The fix is a design decision rather than a patch, and there are at least
three defensible answers — cap Entries and end the Conversation cleanly when it is reached; raise the
model's repeatability; or stop appending every intermediate Entry. Choosing between them decides what a
Transcript promises, and doing that unattended, at the end of a long session, in the loop that drives
every Assistant, is how a wedged Conversation becomes a wedged system. It is pre-existing and not
caused by the letterbox.

**Recommendation:** whatever else, the Loop Driver should refuse to append past the model's limit and
end the Conversation with a reason, so that the failure is *"it filled up"* rather than an infinite
retry against a validation error. `ADR-0015` says nothing ends silently, and this ends nothing at all.

### What the letterbox now does, verified in the deployed container

- `docker compose build runtime` + `up -d --force-recreate runtime`, twice — the second time to pick up
  the neighbouring session's `systemSuffix` work, which is compiled into the image (`/app/dist`, not
  `/app/src` — an earlier check looked in the wrong place and reported a false negative)
- startup logs `the letterbox is configured {"transport":"gmail","host":"","user":"till.gartner@gmail.com","folder":"assistants","allowedSenders":1,"pollIntervalMs":60000}`
- the User's real invoice was moved back to `assistants` by hand, and **the container found it on its
  own schedule**: `polled the letterbox {"fetched":1,"rejected":0,"created":0,"skipped":3,"failed":0}`,
  then moved it to `assistants/processed`

`created: 0, skipped: 3` is the whole point: the three Documents were already there, so the ingest
recognised them by `ExternalRef`, created nothing, and only then moved the message. **Idempotency
proven against real Gmail and the real ThingStore, unattended, inside the container** — which is the
one thing 409 unit tests could not establish.

### B-30 — the same wrong question, asked in two places · FIXED

Removing the `"gmail"` host sentinel corrected the guard in the ingest and missed the copy of it in
`services.ts`, which decides whether to build a connector at all. So a correctly configured Gmail
deployment built no mailbox, logged nothing, and reported `ingested: 0` for ever — the letterbox
silently off with every credential present and correct.

Caught only by rebuilding the container and noticing that a log line which should have appeared did
not. `isConfigured` is now exported and both callers use it: two copies of a predicate is how the
first gets corrected and the second does not.
