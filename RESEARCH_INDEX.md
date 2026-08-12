# Research index

Four research papers live in [`specs/research/`](specs/research/). Each was written to settle
something the code could not decide on its own — what to build on, how the loop should work, what a
field should be, what everyone else does — and each records what it settled, what it did not, and
what has since gone stale.

They are **not** specifications. [`specs/system/`](specs/system/) says what the system is,
[`docs/adr/`](docs/adr/) says what was decided, and these say *why we believed it*. Where a paper
and an ADR disagree, the ADR wins and the paper is the one that is out of date.

| Paper | Question it went to answer | Verdict |
|---|---|---|
| [ACCOUNTING.md](specs/research/ACCOUNTING.md) | What must a bookkeeping system do for us, and should we build one? | **Buy, not build.** Firefly III |
| [AGENTIC_LOOP.md](specs/research/AGENTIC_LOOP.md) | How should the loop that runs an Assistant actually work? | **No workflow engine.** An append-only transcript plus a re-entrant loop |
| [MARKDOWN_FIELDS.md](specs/research/MARKDOWN_FIELDS.md) | How does a Thing hold long-form prose? | **A String plus annotations.** Two of four questions still open |
| [ASSISTANTS_VS_OPENCLAW.md](specs/research/ASSISTANTS_VS_OPENCLAW.md) | What does a mature personal agent do that we do not? | **Two gaps found, both ours.** ADR-0016 and ADR-0017 |

---

## [ACCOUNTING.md](specs/research/ACCOUNTING.md) — what Bookkeeping must provide, and why Firefly III

**Executive summary.** Establishes the vocabulary the Accountant needs — account, transaction,
ledger, balance, budget, reconciliation — then names the ten Operations a Bookkeeping system must
offer, then surveys what exists: server applications (Firefly III, Akaunting, GnuCash) against
plain-text CLI tools (hledger, Beancount, Ledger).

**What it settled.** Firefly III, and the reason is the User rather than the machine: the household
supervises the books directly, so Bookkeeping needs an interface a human works in, which rules out
the plain-text tools whatever their elegance. It also settled that double-entry is worth having for
free — an invoice booked as a payable and then paid is two journals, and a system that models that
natively saves us modelling it.

**What it left open, and what has since bitten.** Firefly's budget is a *recurring cap per period*.
That fits `Expenses:Health` at a monthly limit and fits the house renovation badly — a multi-year
one-off total is not a per-period cap. Firefly also has nowhere to put **committed but not yet
booked** money: an accepted €12,000 roofer's quote is neither a Bill (expected, recurring) nor a
Piggy bank (a savings goal). No External System owns that fact, so the ThingStore would have to.

**Still live.** This paper is executable: `runtime/test/tools.test.ts` **reads its "must provide"
table** and fails the build for any row that is neither implemented nor explicitly marked
*deferred*. Four Operations are deferred on the record — `reverseTransaction`, `markCleared`,
`importStatement`, `exportBooks` — and `reverseTransaction` is the one worth doing next.

---

## [AGENTIC_LOOP.md](specs/research/AGENTIC_LOOP.md) — the loop's open questions, and a survey

**Executive summary.** Poses five questions the concept-level ADRs left unanswered — what the
component that runs everything is called, whether "waiting for X" is one state or several, whether
the clock gives birth or continues, what a `Process` is, and whether to build on Temporal — then
answers them by reading three implementations from source: Opencode, Pi and the Claude Agent SDK.

**What it settled.** Three convergences, reached independently by all three systems: the loop is
stateless and the store is the truth; "waiting for the User" is the *absence* of a running loop;
and the durable transcript and the ephemeral event stream are separate things. Which is
[ADR-0004](docs/adr/0004-assistants-suspend-and-resume.md) arrived at three more times by people
who had not read it.

**The strongest finding is a rejection.** *No Temporal, and no workflow engine.* Three mature
systems achieve durable, restartable, days-long conversations with an append-only transcript in a
dumb store plus a re-entrant loop. Temporal would buy timers and retries; retries are a few lines,
timers are a `wakeAt` field and a scan, and against that stands a cluster to operate and a second
event history that [ADR-0006](docs/adr/0006-one-authority-per-fact.md) forbids.

**The structural claim worth remembering.** *Coding agents assume every tool returns in seconds;
ours are human-paced, so every tool call is potentially suspending, and the pending path is the
normal path.* That single generalisation is what turns a coding-agent loop into this one.

**Then it was built, and four things differed.** `waitingFor: llm` never appears in the store —
only a wait that outlives a Turn is written down. The trigger watcher was indeed the novel
component, but the clock was its *easy* half; making birth exactly-once was the hard one. The loop
needed a step limit after all, because unlike all three surveyed systems nobody is watching. And
the pending tool call held up exactly as predicted.

---

## [MARKDOWN_FIELDS.md](specs/research/MARKDOWN_FIELDS.md) — what is still undecided about markdown fields

**Executive summary.** An Assistant's prompts are markdown
([ADR-0003](docs/adr/0003-assistants-are-things.md)), so a Thing must hold long-form prose. The
mechanism is settled and uses native A12 only — a String field carrying annotations. Four questions
about what goes *in* it were not.

**Answered by building.** The **editor** is lifted from `w12-on-a12` (Lexical-based, with the
collaborative-editing subsystem dropped), and a field becomes a markdown field by three coordinated
facts: `lineBreaksPermitted` on the `StringType`, `"exposition": "AREA"` in the form model, and a
`widget: markdown-editor` annotation on the Control. The **flavour** is GitHub-Flavoured Markdown
plus `remark-directive` containers for admonitions.

**Still open.** Whether markdown may **link to a Thing**, and in what syntax — there is no link
syntax for a ThingID, and inventing one is its own change with its own compatibility problem. And
which **markdown-specific operations** the Data Service should offer, which the build turned out to
need none of, so the question is real but not yet urgent.

---

## [ASSISTANTS_VS_OPENCLAW.md](specs/research/ASSISTANTS_VS_OPENCLAW.md) — the comparison against OpenClaw

**Executive summary.** OpenClaw is a mature personal agent — twenty-six channel integrations, a
scheduler, a skill market, ~3.9M non-test lines. It was read three ways: a c't article and its
figures, the ~11,000-line Python reimplementation *Selma* read at source, and OpenClaw's own
repository, package history and security documentation. Sources are in
[`specs/research/compare_openclaw/`](specs/research/compare_openclaw/).

**The organising difference.** Both systems concluded that the store is the truth and the loop
holds nothing. They diverged on *who owns "what is pending?"* — OpenClaw answers **the gateway**, a
live process that routes, authenticates and executes; we answer **the store**, where pending work
is a query. Their answer buys reach. Ours buys the ability to stop for three weeks in the middle of
a payment and be exactly where it was.

**Where we are stronger.** Waiting is a modelled, queryable state rather than an accident of the
loop ending; every tool call may suspend; the intent log with keyed idempotency, which nothing else
surveyed has; one Authority per fact; tool permission the agent's own process cannot grant itself.

**Where they are stronger.** Reach, working proactivity, memory across runs, compaction, streaming,
and a published security programme — including a threat model that rates its own worst case
*Critical*.

**The two findings, and both are about us.** Our exactly-once birth is a query a Schedule Trigger
cannot ask, because a clock-fired birth has no subject Thing — settled since in
[ADR-0016](docs/adr/0016-a-schedule-fires-on-its-due-instant.md). And our promise that *nothing is
booked without an answer* is a sentence in a system prompt rather than a refusal in the Runtime;
`bookkeeping.postTransaction` is callable on any Turn, and ADR-0012 only stops the *second*
booking. That one is planned, not fixed — see
[`specs/changes/openclaw-learnings/`](specs/changes/openclaw-learnings/).

**A caveat this paper insists on.** The c't article describes OpenClaw as built on Mario Zechner's
Pi toolkit. That was true until 2026-05-28, when three of the four Pi packages were dropped. Any
description of OpenClaw without a date attached should be distrusted, including this one.

---

## Adding a paper

Put it in `specs/research/`, in SHOUTING_CASE like its siblings, and add a row plus a section here.
A paper earns its place by recording **what it went to find out**, **what it settled**, and **what
it did not** — the third being the part that makes it worth keeping once the code exists. Sources
that are not ours (articles, downloads, figures) go in a subdirectory beside it, so a reader can
tell our reasoning from someone else's.
