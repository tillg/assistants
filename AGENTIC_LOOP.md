[TOC]

# Agentic Loop — open research questions

The **agentic loop** is what actually executes an Assistant: it watches Triggers, gives birth to Conversations, drives the exchange with the LLM and its tools, and continues Conversations when the actor they were waiting for responds. The concept-level decisions are recorded in [ADR-0004](docs/adr/0004-assistants-suspend-and-resume.md), [ADR-0005](docs/adr/0005-triggers-give-birth-responses-continue.md) and [ADR-0007](docs/adr/0007-assistants-call-each-other-asynchronously.md). This document collects what is *not* decided, to be settled by a dedicated research thread.

The thread should also survey how existing implementations solve these — [Opencode](https://github.com/anomalyco/opencode), [Pi](https://github.com/earendil-works/pi), the Claude Agent SDK — and what concepts they name.

## Q1 — What is the component that runs all this, and what is it called?

Something detects Triggers, materialises inputs into initial prompts, births Conversations, drives the agentic loop and routes responses back into waiting Conversations. It exists in the design and has no name. Unnamed components are where accidental complexity settles.

Working proposal: call it the **`Runtime`**. It is deliberately *not* an External System — External Systems are what Assistants call, whereas this calls Assistants; the arrow points the other way. Scope limited to three jobs: watch Triggers, birth and continue Conversations, drive the loop.

Open: is `Runtime` the right name and the right boundary, or does it decompose (trigger watcher / conversation store / loop driver)?

## Q2 — Is "waiting for X" one state or several?

A Conversation spends most of its life waiting for another actor to respond: the LLM, the User, or a called tool (and, per ADR-0007, another Assistant).

Working proposal: one state with a variant — `waitingFor: llm | user | tool | assistant`. Waiting on the LLM (seconds) and waiting on the User (days) differ in expected duration, not in shape, and treating them alike makes "show me everything that is stuck" a single query. It also means an LLM call that never returns surfaces in the same place as a forgotten question.

Open: does the difference in timescale eventually force different handling (retry policy, visibility, alerting)?

## Q3 — Does the clock give birth, continue, or both?

Two of our own requirements need time, in two different ways:

- *"Chase this claim if it is still unpaid after 30 days"* — nobody is waiting; a Conversation must be **born**.
- *"Watch the clock and ask the called Assistant what is going on after 5 minutes"* (ADR-0007) — a Conversation **is** waiting and must be **continued**.

Working proposal: two distinct concepts. A **schedule** is a Trigger configured on an Assistant (no Conversation exists yet). A **timeout** is state on a waiting Conversation (wake me even if no answer came). Conflating them is tempting and wrong — one is configuration on a template, the other is state on an instance.

Note: a timeout is also what stops a Conversation waiting forever on an Assistant that died, so ADR-0007's "carry on without the result" is unimplementable without it.

## Q4 — `Process`: passive routing slip, or an actor?

`Process` is the most under-specified Thing in the [README](README.md) and the backbone of the construction-permit scenario. Three shapes:

1. **Passive** — a Thing holding what is done and what is outstanding; any Assistant may append; nothing "runs" it.
2. **Owned** — a dedicated Assistant owns each Process and drives it forward.
3. **A Conversation** — the Process *is* one long-running Conversation.

Working proposal: **passive**. Shape 3 contradicts ADR-0004 outright — a permit spans months and no waiting period may be a live process. Shape 2 fails the permit scenario, where the Receptionist (mail arrives), the Accountant (fees) and the User (signatures) all touch the same Process and a single owner would have to broker everything.

Under the passive shape the line is clean: **Conversations are episodes, the Process is the plot.** The Process is durable memory that outlives every Conversation touching it, and a change to a Process is itself a Trigger, so appending a step can wake whoever cares. A standard workflow (processing a doctor's invoice) and an ad-hoc one (obtaining a construction permit) then differ only in whether the Process Model carries a step template.

## Q5 — Is Temporal the right foundation?

Would [Temporal](https://temporal.io/) be the technology to build the loop on? It is worth a serious look because its model matches several decisions we have already made: durable execution that survives restarts, activities that may take days, timers as first-class citizens, and signals that resume a waiting workflow.

Points to examine:

- A Temporal workflow maps naturally onto a Conversation, an activity onto a tool or Connector call, a signal onto the User answering an Open Question, and a timer onto both the schedule and the timeout from Q3.
- But ADR-0004 puts a Conversation's state in the **ThingStore**, whereas Temporal keeps its own event history. That is two Authorities for the same state, which ADR-0006 forbids — so the split has to be worked out deliberately, not inherited.
- Weigh the operational cost (a Temporal cluster) against what it replaces for a single-household system.
