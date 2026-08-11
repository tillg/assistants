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

The article describes OpenClaw as Peter Steinberger's locally-running personal agent
with a gateway, channels, a heartbeat, markdown skills and ~350k lines. Research
confirmed the identity and the naming history. Where a claim rests only on the
article and not on a primary source, the document says so in place rather than
presenting it as fact.

### D3 — Selma is treated as the readable proxy, OpenClaw as the design

The article's own framing: Selma (~2,500 lines) reimplements OpenClaw's core concepts
to make them legible. The document compares **concepts** against Assistants and uses
Selma's code only where it makes a concept concrete.

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

### D9 — Written on two of three research reports

Three research agents ran in parallel: our own system, the Selma source, and OpenClaw + Pi from
primary sources. The first two returned. The third was still running after ~35 minutes, so I
wrote the document rather than block on it, and made the gap explicit instead of papering over
it: every claim about OpenClaw *itself* is marked *(article)* and the closing section says
plainly that OpenClaw's source was not read.

This is the honest position anyway. Selma is a declared toy, and the article is the only
first-hand description of OpenClaw we hold. Had the third report arrived it would have upgraded
*(article)* markers to citations; it would not have changed a single conclusion, because every
conclusion rests on our side of the comparison or on Selma's source.

⚠ worth a look — if you want the OpenClaw claims verified against its repository, that is a
follow-up read, not a rewrite.

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
