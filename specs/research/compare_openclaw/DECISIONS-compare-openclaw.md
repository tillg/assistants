# Decisions and assumptions — `compare_openclaw`

Working log for the autonomous run of 2026-08-11. Everything here is a call I made
without being able to ask; review the ones marked **⚠ worth a look**.

## The task as I read it

The change asks for one deliverable: a document `assistants_vs_openclaw.md` that
explains the findings, compares concepts, says what Assistants could learn, and says
where Assistants is stronger. No code. Commit and push before the research, and again
after.

## Decisions

### D1 — Where the document lives, and how it is named

The change note spells the file `assistants_vs_opencalw.md` (transposed letters). I
took that as a typo and wrote **`ASSISTANTS_VS_OPENCLAW.md` in the repository root**.

Reasons: the root already holds the project's cross-cutting companion documents in
SHOUTING_CASE — `CONTEXT.md`, `DECISIONS.md`, `AGENTIC_LOOP.md`, `ACCOUNTING.md`,
`MARKDOWN_FIELDS.md`, `BUGS.md` — and this is exactly that kind of document: a survey
that informs the whole system rather than one change. `AGENTIC_LOOP.md` in particular
already carries a survey of three agent systems, and this is its sibling.

⚠ worth a look — if you would rather have it under `docs/` or keep the lower-case
name, it is a one-line `git mv`.

### D2 — What "OpenClaw" is taken to mean

OpenClaw is [openclaw/openclaw](https://github.com/openclaw/openclaw), MIT, ~90%
TypeScript. The article's description was checked against the repository and found
stale in two places — the Pi dependency and the line count (see D9). Every claim
carries its source: **(article)** where it rests only on the c't piece, **(Selma)**
where it comes from the reimplementation, unmarked where it comes from OpenClaw's own
repository and docs.

Two figures were deliberately **not** cited because their sources contradict each
other by three orders of magnitude: the size of the public skill hub, and with it the
article's "over a hundred community skills". The document says so rather than picking
one.

### D3 — Selma is treated as the readable proxy, not as evidence

The article's framing is that Selma reimplements OpenClaw's core concepts to make them
legible, and the document uses it that way: to make a concept concrete, never as
evidence about OpenClaw's engineering. Selma is a declared toy with no authentication
and several real bugs, and saying "OpenClaw does X" because Selma does would be unfair
to both. Where Selma's flaws are cited it is as a cautionary tale about the *shape*,
explicitly marked, and §3 of the document says outright that Selma's missing auth must
not be read as OpenClaw's posture.

### D4 — The OpenTelemetry position is argued, not just asserted

`compare_openclaw.md` states the position — "we don't want OpenTelemetry, we need to
make our system inspectable and understandable by itself." I did not treat that as
settled by fiat; the document gives the strongest version of the opposing case and
then says why the position still holds, and separates the two things the article
conflates (a wire protocol vs. a developer-facing trace UI).

### D5 — Learnings are ranked and costed, not listed

A flat list of "things we could steal" is not usable. Each learning gets a verdict —
adopt / adapt / reject — with what it would cost and what it would break. Rejections
are stated as plainly as adoptions.

### D6 — No code, no ADRs, no `specs/system/` edits

The change says research and documentation only. I did not open ADRs for the
recommendations, did not touch the system specs, and did not change any code. The
document names which ADR each recommendation would need if pursued.

### D7 — README gets one line

The global instruction is to update `README.md` when a change is user-visible. A new
top-level companion document is exactly that, so it joins the companion-documents
list. That is the only edit outside the new file.

### D8 — British English, project vocabulary

The project fixes its spelling and its words in `CONTEXT.md`. The document uses
Assistant / Conversation / Thing / Trigger / Turn / Runtime for our side and
gateway / session / channel / skill for theirs, and never blurs the two.

### D9 — Written on two of three reports, then rewritten when the third arrived

Three research agents ran in parallel: our own system, the Selma source, and OpenClaw + Pi from
primary sources. The first two returned; the third was still running after ~35 minutes, so I
wrote a first version on two of three and marked every OpenClaw claim *(article)*.

**I predicted in this file that the third report "would not change a single conclusion". That was
wrong, and the document was rewritten.** What it changed:

- **OpenClaw dropped Pi's agent core on 2026-05-28** — three of four packages gone, only the
  terminal-UI renderer kept. The article's ground and first floors describe an architecture the
  project left ten weeks ago. The first version's framing, "Pi is OpenClaw's first floor", was
  stale; the document now opens by saying so.
- **The "350,000 lines" figure is not supportable.** Measurement of HEAD puts it an order of
  magnitude higher. No primary source for the article's number exists.
- **Their skills are progressively disclosed too** — I had presented that as something to learn
  from Selma alone.
- **Their heartbeat is a job of a real scheduler**, with quiet hours, backoff and auto-disable. A
  sentence claiming our `cron` field was "already a stronger model" was true of Selma and false of
  OpenClaw; it is gone.
- **The published security work opened §7**, which is the most valuable section in the document and
  did not exist in the first version.

The lesson is the one the project already writes down about green tests: a conclusion drawn from
two of three sources is evidence about those two.

⚠ worth a look — the rewrite is `fbe79c9..HEAD` on `ASSISTANTS_VS_OPENCLAW.md` if you want to see
what moved.

### D12 — §7 states a defect in our system, and does not fix it

The comparison surfaced something sharper than the Schedule Trigger gap: the Accountant's *"Never
book without an explicit yes"* is a **system prompt, not a mechanism**.
`bookkeeping.postTransaction` is granted and callable on any Turn. ADR-0012 stops the same booking
landing twice; nothing stops a *first* booking that was never approved. The end-to-end tests script
a model that chooses to ask, so they prove the suspend-and-resume machinery, not the rule.

I wrote it up as the document's headline finding, with a proposed fix that fits the existing grain
(an Operation declares that it requires an answered Open Question; the check goes where the intent
is already written; the missing-approval path is `pending`, which the loop already has).

I did **not** implement it, open an ADR, or change a prompt. The change says research and
documentation only, and this one deserves a decision rather than a quiet patch.

⚠ **This is the item to look at first.** It is a real gap at the one boundary where money moves,
and it has not been demonstrated against a live model — only read from the seeds and the registry.

### D10 — The Schedule Trigger finding is stated as a finding, not fixed

Reading Selma's heartbeat surfaced something about *our* system that is not written down
anywhere: the watcher's exactly-once guarantee for birth is the query *no Conversation exists for
`(assistantKey, subjectThingId)`*, and a clock-fired birth has no subject Thing, so that query
has no answer for a Schedule Trigger.

I did not open an ADR or write code — the change says research and documentation only. The
document names the gap, proposes `(assistantKey, scheduledFor)` keyed on the **due instant**
rather than the scan moment, and says why. Deciding it is yours.

### D11 — The channel recommendation carries its own caveat

"A channel is a Connector, not a gateway" is the document's main constructive claim. Checking it
against ADR-0014 showed it is not quite free: an Open Question has one writer after creation, the
User, so a Runtime-side connector stamping the answer would be the second-writer hazard that
moved answer consumption onto the Conversation. Rather than drop the recommendation or hide the
wrinkle, the document states the fork — authenticate as the User, or deliver as an Entry — and
leaves it open.

## Assumptions

- **A1** — The reader is the project owner: deep on Assistants, has read the article,
  has not read OpenClaw's or Selma's source. So the document is thin on re-explaining
  our own architecture and thick on theirs plus the comparison.
- **A2** — "Where our concepts are better" means *for this system's purpose* (unattended
  household admin under supervision), not in the abstract. A design that is worse for
  us may be right for a personal chat agent, and the document says so where it applies.
- **A3** — The images shipped with the change are the article's figures. The document
  does not embed them; it refers to the article.

## What I could not verify

Recorded in the document itself, in a closing section, so that a later reader knows
which claims are load-bearing and which are second-hand.
