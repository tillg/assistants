# Bugs

Findings from a bug hunt against the running stack on **2026-08-09**, at commit `29bb0f6`.

**43 defects, every one reproduced** — not inferred from reading code. Each entry says how it was
executed and what came back. Where a hunter substituted something, it was never the component the
claim is about; the D-017 lesson ("green tests were evidence about the fake, not about the system")
was the standing rule of the hunt.

## What has happened since

This file was written at `29bb0f6` and committed by `495310a`, which **fixed twelve of these findings
in the same commit** — so the sentence that used to stand here, "nothing here is fixed", was untrue of
the file the moment it landed. Do not trust an entry's *Observed* block without reading its **Status**.

On **2026-08-10** all 43 were re-verified against the code as it then stood, and each was given a
reproducing test and a fix. Every entry below now opens with a **Status** line saying what was actually
true on re-verification and what was done. Nine of the reports needed correcting — a wrong cause, an
overstated impact, or a sub-claim that turned out to be false — and each correction is stated in the
entry it belongs to rather than quietly applied.

The run's decisions, the assumptions behind them, and what is deliberately left undone are in
[`AUTONOMOUS-BUGFIX-LOG.md`](AUTONOMOUS-BUGFIX-LOG.md).

## How it was produced

Five parallel lines of attack against the live stack, each on a different surface: the web
application through a real browser, the ThingStore's JSON-RPC and the Runtime's tool layer, the
Runtime's loop and watcher under vitest against the real modules, the Firefly connector against the
live Firefly, and the models plus the validator plus the project's own documentation.

Scratch scripts and the five full hunter reports are under `tmp/hunt/` (gitignored, so this file is
self-contained). Repro commands below name those scripts where one exists.

**Four findings were re-run independently by a second party** before publication and reproduced
exactly: BUG-01, BUG-02, BUG-05, BUG-07.

## Summary

| # | Severity | Component | Title | Status |
|---|---|---|---|---|
| [BUG-01](#bug-01) | **critical** | client | Answering an Open Question in the UI never resumes the Conversation | Fixed |
| [BUG-02](#bug-02) | high | connector/firefly | `listOpenItems` never reports an unpaid invoice — every payable is filtered out | Already fixed, now guarded |
| [BUG-03](#bug-03) | high | connector/firefly | Nothing stops the same invoice being booked twice | Fixed |
| [BUG-04](#bug-04) | high | connector/firefly | `getBudgetReport` reports neither the budget nor what was spent | Fixed |
| [BUG-05](#bug-05) | high | runtime/tools | `thingstore.update` destroys a Process's append-only step history | Fixed |
| [BUG-06](#bug-06) | high | runtime/watcher | The materialised scan permanently loses Things past the first 100-row page | Fixed |
| [BUG-07](#bug-07) | high | runtime/watcher | `just pause` is silently reverted by the Runtime | Already fixed, plus a residual |
| [BUG-08](#bug-08) | high | runtime/watcher | The watermark advances past a Thing it deliberately skipped | Fixed |
| [BUG-09](#bug-09) | high | runtime/loop | Lease recovery of `assistant.call` reports a call that *did* happen as "it did not take effect" | Fixed |
| [BUG-10](#bug-10) | high | runtime/loop | Recovering an interrupted `ui.askUser` resumes without the answer and orphans the question | Fixed |
| [BUG-11](#bug-11) | high | runtime/loop | An unreconcilable intent escalates forever, and its transcript is invalid to both real LLM providers | Fixed |
| [BUG-12](#bug-12) | high | runtime/tools | Calling a **disabled** Assistant strands both Conversations, silently | Fixed |
| [BUG-13](#bug-13) | high | runtime/tools | `thingstore.search` returns an arbitrary subset, not "the most recent ones" | Fixed |
| [BUG-14](#bug-14) | high | runtime/tools | A ThingStore rejection reaches the Assistant as a stack trace with the reason removed | Fixed |
| [BUG-15](#bug-15) | high | models / client | Two of the eight detail forms cannot be opened at all, and fail silently | Fixed |
| [BUG-16](#bug-16) | medium | connector/firefly | Two concurrent posts with the same idempotency key both land | Fixed |
| [BUG-17](#bug-17) | medium | connector/firefly | A split's `currencyCode` is silently ignored — $50 is booked as €50 | Fixed — and the stated cause was wrong |
| [BUG-18](#bug-18) | medium | connector/firefly | `categoryName` is passed as a name and Firefly silently creates it | Fixed |
| [BUG-19](#bug-19) | medium | connector/firefly | A booking the User deleted in Firefly can never be re-made under its own key | Fixed |
| [BUG-20](#bug-20) | medium | runtime/tools | Half of the Operations ACCOUNTING.md requires do not exist | Partly fixed, the rest deferred on the record |
| [BUG-21](#bug-21) | medium | runtime/tools | Firefly validation errors reach the model as a stack trace naming IDs it never saw | Fixed |
| [BUG-22](#bug-22) | medium | runtime/tools | Concurrent search-then-create yields duplicates under one idempotency key | Fixed |
| [BUG-23](#bug-23) | medium | thingstore | The `runtime` identity can create and modify `Assistant_DM`, which it is documented never to write — **write half fixed**, read half open | Write half fixed; read half open |
| [BUG-24](#bug-24) | medium | models | An Invoice with no number, no issuer, no date and no amount is accepted | Fixed |
| [BUG-25](#bug-25) | medium | runtime/loop | The turns-exhausted escalation asks a question the User cannot act on, then kills the Conversation | Fixed |
| [BUG-26](#bug-26) | medium | docs | `CONVENTIONS.md` instructs the reader to reintroduce the D-019 overview crash | Fixed |
| [BUG-27](#bug-27) | medium | models | The validator misses an `EnumerationType` on a Runtime-filtered field | Fixed |
| [BUG-28](#bug-28) | medium | models | "The four machine fields, in order" is unenforced, and one of them carries the runaway guard | Fixed |
| [BUG-29](#bug-29) | medium | docs | Following README "Adding a Thing" verbatim produces a model the validator rejects | Fixed |
| [BUG-30](#bug-30) | medium | ops | `just bootstrap` never updates a seeded Assistant, though README says to re-run it for that | Fixed |
| [BUG-31](#bug-31) | low | runtime/watcher | A **detached** `assistant.call` rewrites a finished caller's transcript | Fixed |
| [BUG-32](#bug-32) | low | connector/firefly | Ambiguous account names resolve silently to whichever Firefly listed first | Fixed — one sub-claim corrected |
| [BUG-33](#bug-33) | low | connector/firefly | The chart of accounts handed to the model includes Firefly's internal accounts | Fixed — the second claim was not a bug |
| [BUG-34](#bug-34) | low | models | Emoji and other non-BMP characters are refused by every plain string field | Documented; not fixable here |
| [BUG-35](#bug-35) | low | runtime/tools | `thingstore.search` with a field but no value is a hard error, not an empty filter | Fixed |
| [BUG-36](#bug-36) | low | client | A UI save does not maintain the Model's own `updatedAt` | Documented; not fixable in the client |
| [BUG-37](#bug-37) | low | client | A wrong password answers HTTP 500, not 401 | Obsolete — not reproducible |
| [BUG-38](#bug-38) | low | docs | README "Status and limitations" is false on three counts about the e2e suite | Fixed |
| [BUG-39](#bug-39) | low | docs | The README test tables omit `test-integration`, which `just test` runs | Fixed |
| [BUG-40](#bug-40) | low | ops | `just` prints truncated, subjectless descriptions for five recipes | Fixed |
| [BUG-41](#bug-41) | low | docs | The repository tree says ten ADRs; there are fifteen | Fixed |
| [BUG-42](#bug-42) | low | ops | The e2e package fails its own lint and format gates, and nothing runs them | Fixed |
| [BUG-43](#bug-43) | low | models | Bilingual labels and "model id matches filename" are stated as rules and not enforced | Fixed |

---

# Critical

<a id="bug-01"></a>
## BUG-01 — Answering an Open Question in the UI never resumes the Conversation

> **Status (2026-08-10): Fixed.** The watcher half was fixed in `495310a` (`isAnswered`). Two halves closed here: the e2e page object stopped stamping `answeredAt`, so the suite now answers the way a User does, and both `reconcile` paths use the same predicate as the scan.

**Severity** critical · **Component** client (`import/models/openquestion/OpenQuestion_FM.json`) +
runtime/watcher

This is the product's core interaction. README: *"The User answers it in the web application —
hours or days later, across as many restarts as you like — and only then does the transaction land
in the real books."* It does not land.

**Repro**
1. Log in at <http://localhost:8081> as `admin` / `A12PT-admintest`.
2. Open Questions → click the accountant's *"Book this invoice?"* row.
3. Set **Confirmed** = `yes`, type an answer in the **Answer** editor, press **Save**.
4. Do *not* touch the **Answered at** field — nothing marks it as required, it has no default, and
   no text anywhere says it matters.
5. Watch `docker logs -f assistants_runtime`.

**Observed** — the save lands, and nothing else happens, indefinitely.

```
# the question, straight out of the store after the UI save
"Confirmed": true,
"Text": "Yes, book it. Answered from the UI without touching Answered at.",
"__meta": { "modifiedAt": "2026-08-09T20:17:31", "modifier": "admin" }
# there is no AnsweredAt key at all

# the Conversation, three and a half minutes later
status: waiting | waitingFor: user | currentQuestionId: 6d4e9889-… | turns: 2
```

The watcher's answered-question scan is `if (!question.data.answeredAt) continue;`
(`runtime/src/watcher/watcher.ts:280`). No `answeredAt`, no resumption — and no other scan can
reach a Conversation `waiting` on `user`.

**Positive control** — stamping that one field, changing nothing else, revives it within one scan:

```
stamped AnsweredAt = 2026-08-09T20:21:00
20:21:03 INFO scan did work {"births":0,"continuations":1}
20:21:05 INFO conversation finished {"conversationId":"2c7ba816-…","assistant":"accountant","turns":4}
20:21:08 INFO conversation finished {"conversationId":"72966f47-…","assistant":"receptionist","turns":3}
```

**Expected** — saving an answer is the act of answering. `answeredAt` is machine state; the form
should stamp it on save (or the watcher should key off the answer's presence). Today the User must
know to fill in a timestamp by hand, and forgetting it strands the Conversation with no error, no
badge and a green heartbeat. Every Manual Connector (`email.send`, `bank.sendMoney`,
`document.requestText`) reports back through the same form and fails the same way.

**Note** — the e2e suite does not catch this because `e2e/pages/OpenQuestionPage.ts` sets
`answeredAt` itself before saving. The test knows something the User is not told.

**Verified by** the browser, the ThingStore API and the Runtime's own log, with the positive control
above.

---

# High

<a id="bug-02"></a>
## BUG-02 — `bookkeeping.listOpenItems` never reports an unpaid invoice

> **Status (2026-08-10): Already fixed, now guarded.** Fixed in `495310a`. It was guarded by nothing — the unit fake returned `[]` and typed `Payables` as the singular — so an integration test now asserts the plural `liabilities`, and the fake was corrected.

**Severity** high · **Component** connector/firefly (`runtime/src/connectors/firefly.ts:313`)

**Repro** `cd runtime && npx tsx ../tmp/hunt/firefly/07-openitems-isolate.ts`

**Observed** — the demo household's `Payables` carries **−3 850.30 EUR** across 15 journals.

```
--- accounts matching /payable|receivable/i
[ { "name": "Payables",                "type": "liabilities", "balance": "-3850.30" },
  { "name": "HUNT Payable",            "type": "liabilities", "balance": "-6476.08" },
  { "name": "Receivable from insurer", "type": "asset",       "balance": "0"        },
  { "name": "HUNT Receivable",         "type": "asset",       "balance": "77"       } ]
--- listOpenItems()
[ { "id": "11", "name": "HUNT Receivable", "type": "asset", "currentBalance": "77" } ]
```

The filter accepts `type === "liability" | "asset" | "debt"`. Firefly's `/accounts` returns
**`"liabilities"`**. The connector's own `createAccount()` sends `type: "liability"` and Firefly
stores `liabilities` — so it cannot recognise the accounts it creates itself. Every payable is
dropped; the asset half of the same filter works, which is what makes the one-word cause visible.

**Expected** — both payables. ACCOUNTING.md calls this the point of the design: *"invoice tracking
falls out of double entry for free — an unpaid invoice is just a non-zero balance on a payable
account"*. The Accountant's own skill says *"`bookkeeping.listOpenItems` returns both. When asked
what is outstanding, **report from that call and nothing else**."* So the Accountant, asked what is
unpaid, answers "nothing" while €3 850.30 sits unpaid.

**Why no test caught it** — `runtime/test/support/harness.ts:62` implements `listOpenItems()` as
`return []`. The fake agrees with the bug, and there is no integration test for it. D-017's lesson,
verbatim.

---

<a id="bug-03"></a>
## BUG-03 — Nothing stops the same invoice being booked twice

> **Status (2026-08-10): Fixed.** `postTransaction` asks the `thing:` tag whether this exact posting is already booked, comparing date, amount, type and both account ids — never the tag alone, because one invoice legitimately has up to four journals.

**Severity** high · **Component** connector/firefly

**Repro** `cd runtime && npx tsx ../tmp/hunt/firefly/06-dup-and-race.ts` — two `postTransaction`
calls, same `thingId`, same date, amount, description and accounts, different idempotency keys.
That is what two Turns, or two Conversations about one invoice, produce.

**Observed**

```
{ "thingId": "d23edf6f-…", "a": { "id": "49", "alreadyExisted": false },
                            "b": { "id": "50", "alreadyExisted": false } }
```

Both landed despite `error_if_duplicate_hash: true`, because `external_id` — which carries the
idempotency key — participates in Firefly's duplicate hash. Proved independently: a byte-identical
re-post is refused under the *same* key (`422 Duplicate of transaction #66`) and accepted under a
*fresh* one.

The live books already show it: `Payables` holds **twelve** identical journals `2026-08-01
"Consultation and dressing change, 24 July" 96.50 EUR`, each with a different conversation-shaped
`external_id` — €1 062 of them.

**Expected** — the tool tells the model *"Safe to retry: booking the same thing twice is a no-op."*
That holds only inside one Turn. The connector already receives the Invoice's `thingId` and already
writes a `thing:<id>` tag, so it *can* ask (`tag_is:"thing:<id>"` works) and never does. D-016
records the belief that *"what actually stood between a crash and a double booking was Firefly's
`error_if_duplicate_hash`"*; that net has no threads in it, because the key it hashes is the thing
that differs.

---

<a id="bug-04"></a>
## BUG-04 — `bookkeeping.getBudgetReport` reports neither the budget nor what was spent

> **Status (2026-08-10): Fixed.** `listBudgets(period)` joins `GET /budgets` with `GET /budget-limits`, so both numbers are in the answer. `spent` is a number and never null; a budget with no limit reports none rather than zero. `getBudgetReport` gained `start`/`end`, defaulting to this month.

**Severity** high · **Component** connector/firefly

**Repro** `cd runtime && npx tsx ../tmp/hunt/firefly/09-budgets.ts` — books €200.00 against the demo
budget **Health** (limit €300 for August), then asks the Operation and asks Firefly.

**Observed**

```
--- connector.listBudgets()  == bookkeeping.getBudgetReport
[ { "id": "1", "name": "Health", "spent": null }, { "id": "2", "name": "Renovation", "spent": null } ]

--- Firefly with a period (what its own UI shows)
[ { "name": "Health", "spent": [ { "sum": "-200.00", "currency_code": "EUR" } ] }, … ]

--- Firefly budget-limit for Health in August
[ { "start": "2026-08-01…", "end": "2026-08-31…", "amount": "300", "spent": [ { "sum": "-200.00" } ] } ]
```

`listBudgets()` calls `GET /budgets` with no `start`/`end`, and Firefly only computes `spent` for a
period. It never reads `/budgets/{id}/limits`, so the target amount is never in the answer at all.

**Expected** — ACCOUNTING.md requires `getBudgetReport(period)` = *"Actual vs. budget per account"*,
and the tool's description is *"Budgets and what has been spent against them"*. It returns neither
number, and `spent: null` reads to a model like "nothing spent". ADR-0006 makes Bookkeeping the
Authority for budgets, so nothing else can supply it.

**Why no test caught it** — `FakeFirefly.listBudgets()` returns `[]` (`harness.ts:65`).

---

<a id="bug-05"></a>
## BUG-05 — `thingstore.update` destroys a Process's append-only step history

> **Status (2026-08-10): Fixed.** Repeating-group rows are merged by key (`seq` for steps, `thingId` for related) rather than replaced, so "add step 4" adds it and re-sending the whole list does not duplicate. `steps: []` no longer wipes.

**Severity** high · **Component** runtime/tools

**Repro** `cd runtime && npx tsx ../tmp/hunt/thingstore/10-update.ts` (sections A and B)

**Observed** — re-run independently:

```
=== A: Process.Steps is documented as an append-only list ===
created with 3 steps: 0352cc22-c752-44c2-a337-e97e85ea5537
update with steps:[{seq:4,...}] -> {"thingId":"0352cc22-…","model":"Process_DM","updated":true}
steps now: [{"seq":4,"title":"Paid","state":"done"}]
```

Steps 1–3 ("Received", "Checked", "Booked", with their notes) are gone. The tool reports
`updated: true` and nothing records the loss.

**Expected** — README calls the Process *"the routing slip — a title, a status and an **append-only
list of steps**"*, and the tool promises *"Supply only the fields you are changing; the others are
preserved"* (`tools.ts:143-145`). That holds for scalars and is false for the `steps` and `related`
groups: the supplied array replaces the whole group. There is no append affordance, so the obvious
model move ("add step 4") is destructive. An update that does not mention the group is safe —
section B confirms it survives a `status`-only update.

---

<a id="bug-06"></a>
## BUG-06 — The materialised scan permanently loses Things past the first 100-row page

> **Status (2026-08-10): Fixed.** Together with BUG-08: the candidate query is ordered `createdAt` ASC and the watermark may only pass a contiguous run of decided Things, clamped per Model. A full page contributes a ceiling, because a full page means there is more behind it.

**Severity** high · **Component** runtime/watcher

**Repro** `cd runtime && npx tsx ../tmp/hunt/thingstore/08-watermark.ts` (part 2) — 150 Invoices
with explicit `createdAt` one second apart, then the watcher's own `date_range` query
(`watcher.ts:129-136`) through `ThingRepository.search(spec, constraint, 100)` and the watcher's own
`newestSeen` computation (`watcher.ts:196-204`).

**Observed**

```
pretend watermark: 2026-08-09T20:14:28
created: 150 Invoices, createdAt 20:14:29 .. 20:16:58
the scan's query returned 100 rows, 86 of them mine
newestSeen (the new watermark) would be: 2026-08-09T20:20:39
Invoices that exist, were never returned, and are now BEHIND the new watermark: 64
of those, still invisible on the NEXT scan too: 64 / 64
```

The page is unsorted (see BUG-13), so it is not even "the oldest 100"; `newestSeen` is the maximum
over an arbitrary window, and everything outside it is stepped over for good.

**Expected** — `scanMaterialised` guards carefully against advancing past a *skipped* Thing:
*"Advancing it past one that was skipped … would put it permanently behind the watermark and it
would never be birthed at all"* (`watcher.ts:194-196`). That protection covers only Things the scan
looked at. README's "birth is exactly-once by query" becomes at-most-once. Reachable whenever more
than 100 trigger-eligible Things land between two scans (two seconds): a bulk import, a large
`just demo-data`, a connector delivering a mailbox.

---

<a id="bug-07"></a>
## BUG-07 — `just pause` is silently reverted by the Runtime

> **Status (2026-08-10): Already fixed, plus a residual.** Fixed in `495310a`; a regression guard now holds it. The residual is closed too: only `paused` was carried forward, so a watermark another writer had moved forward was still trampled. The non-atomic re-read remains and cannot be closed without compare-and-swap — recorded in the code.

**Severity** high · **Component** runtime/watcher

The global kill switch. README: *"An Assistant is doing something you did not expect."*

**Repro** `cd runtime && npx tsx ../tmp/hunt/thingstore/07-pause-race.ts` — 25 attempts, each
creating an Invoice so the materialised scan's `saveState()` fires, then calling the product's own
`setPaused(things, true)` (the exact function behind `just pause`) at a varying offset inside the
2 s scan interval.

**Observed** — re-run independently, **3 of 25 pauses silently undone**:

```
initial:    {"paused":false,"watermark":"2026-08-09T20:31:47","heartbeatAt":"2026-08-09T20:32:01"}
attempt 1:  PAUSE REVERTED by the Runtime after 134ms {"paused":false,"watermark":"20:32:04","heartbeatAt":"20:32:01"}
attempt 13: PAUSE REVERTED by the Runtime after 132ms
attempt 20: PAUSE REVERTED by the Runtime after 135ms
attempts: 25   pause silently reverted: 3
```

In each case `watermark` moved while `heartbeatAt` did not — pinning `scanMaterialised`'s
`saveState()` (`watcher.ts:208-212`) as the writer, not `stampHeartbeat()`.

**Expected** — `stampHeartbeat` re-reads `paused` before writing and says exactly why:
*"**Re-reads before writing.** … writing the whole in-memory copy back at the end would silently
undo a `just pause` issued in between — the global kill switch, lost, with nothing saying so."*
(`watcher.ts:570-575`). `scanMaterialised` writes the same document through the same whole-document
update **without** that re-read, so the hazard the comment describes is live in the very next
method. `just pause` still logs `runtime paused` and exits 0, so the operator gets no signal.

Root mechanism: A12 has no optimistic locking and `__meta` carries no version or etag, so a stale
whole-document write always wins (`06-idempotency.ts` §E reproduces the lost update directly).

---

<a id="bug-08"></a>
## BUG-08 — The watermark advances past a Thing it deliberately skipped

> **Status (2026-08-10): Fixed.** See BUG-06 — one broken invariant, one fix. A skipped Thing now freezes its Model's frontier instead of being stepped over, and the per-Model frontier stops one Model's progress burying another's.

**Severity** high · **Component** runtime/watcher

**Repro** `cd runtime && npx vitest run --config ../tmp/hunt/runtime/vitest.config.ts -t "buries a Document"`

Two Things past the watermark: **A** at `T-120s`, carrying the `createdByConversationId` of a still
`running` Conversation; **B** at `T-60s`, ordinary.

**Observed** — A is correctly skipped, B is birthed, and the watermark is then advanced to *B's*
`createdAt`. A is now strictly behind it and is excluded by both the `date_range` constraint and the
explicit `createdAt < watermark` guard. Finishing the blocking Conversation changes nothing: three
further scans birth nothing for A.

```
watermark after scan: 2026-08-09T20:11:26   skipped doc createdAt: 2026-08-09T20:10:26
conversations about the skipped document: 0
conversations about any document        : 1
```

The `decided` flag guards only the Thing being examined; the `continue` for a running creator
happens before it is consulted, and `newestSeen` is raised by any later Thing in the same pass —
including Things of a different Model, since the trigger-eligible models share one watermark.

**Expected** — in the live flow this is the Receptionist creating an `Invoice_DM` while its own
Conversation still runs: the Invoice is correctly skipped on that pass, and any Thing created a
second later buries it. The Accountant never wakes for it and nothing says why. Distinct from
BUG-06: that one loses Things never looked at, this one loses Things looked at and set aside.

---

<a id="bug-09"></a>
## BUG-09 — Lease recovery of `assistant.call` reports a call that *did* happen as "it did not take effect"

> **Status (2026-08-10): Fixed.** The reported symptom was already gone in `495310a`. What the report calls the compounding problem is fixed here: `assistant.call` gained a `reconcile` that finds the child born under the caller's own idempotency key.

**Severity** high · **Component** runtime/loop

**Repro** `cd runtime && npx vitest run --config ../tmp/hunt/runtime/vitest.config.ts -t "mis-names the operation"`
— advance a Turn calling `assistant.call:accountant`, truncate the transcript at the intent (what a
crash actually looks like), expire the lease, scan.

**Observed**

```
intent.toolName = "assistant.call.accountant"
granted names   = ["assistant.call:accountant"]
reconciled result: Error: this call was interrupted, and "assistant.call.accountant" is no longer
                   available, so it did not take effect.
child conversations for accountant: 2
```

The Operation name round-trips through the wire encoding and comes back mangled:
`toolNameForLlm("assistant.call:accountant")` → `assistant__call__accountant`, and
`operationFromLlm` turns `__` back into `.` unconditionally — a dot where the colon was. Execution
survives because `advance()` looks the tool up by the wire name first (`advance.ts:301`);
`reconcile()` has no such fallback (`advance.ts:405-407`), finds nothing, and takes the "nothing did
it" branch. The model, told the call did not happen, calls again — and a second child Conversation
is born.

**Expected** — ADR-0012: *"Anything reading one … must treat an intent without a result as
**unknown**, never as failed."* D-017: *"A mutating tool that cannot answer forces an escalation to
the User rather than a guess."* The naming bug converts that escalation into a confident, wrong
"nothing happened". Compounding: `assistant.call` is the one mutating tool with no `reconcile` at
all, so a working lookup would have escalated correctly.

---

<a id="bug-10"></a>
## BUG-10 — Recovering an interrupted `ui.askUser` resumes without the answer and orphans the question

> **Status (2026-08-10): Fixed.** `reconcile` returns the Operation's own `ToolOutcome | undefined`, so a `pending` verdict is honoured instead of read as settled, and the suspended state has exactly one writer.

**Severity** high · **Component** runtime/loop

**Repro** `-t "resumes and finishes while the Open Question"` — the Assistant calls `ui.askUser`,
the question is created, the process dies before the suspension is written, the lease expires.

**Observed**

```
conversation status after recovery: done
conversation result: No answer came, so I assumed yes and carried on.
question answeredAt: undefined
conversation currentQuestionId: ""
```

`ui.askUser.reconcile` correctly returns `{kind:"pending", waitingFor:"user", questionId}`, but
`LoopDriver.reconcile` writes it as a tool result and returns **`true` — "settled"**
(`advance.ts:454-466`). `advance()` then runs a fresh Turn without ever setting `status="waiting"`,
`currentQuestionId` or `waitingFor`. The Conversation reaches `done` while the User's question is
still open, and with `currentQuestionId === ""` answering it later matches no scan.

**Expected** — a `pending` reconcile means the suspension still holds; the Conversation should
return to `waiting` on that question, as `advance.ts:359-363` already does on the normal pending
path. Every Manual Connector returns the identical `pending` shape (`tools.ts:532-541`), so a crash
during a payment request resumes the Assistant as if it had been told nothing, with the request
still on the User's list.

---

<a id="bug-11"></a>
## BUG-11 — An unreconcilable intent escalates forever, and its transcript is invalid to both real LLM providers

> **Status (2026-08-10): Fixed.** An unreconcilable intent now gets a tool result saying `"outcome":"unknown"`, `"retry":false` — so it is not re-found every wake, and the transcript no longer carries a tool call with no result, which both real providers reject.

**Severity** high · **Component** runtime/loop

**Repro** `-t "re-escalates on every answer"` and `-t "sends an assistant tool_call"` — crash one
step earlier than BUG-10: the intent is written, the Open Question never created.

**Observed**, two compounding problems.

1. The escalation writes no tool result for the intent, so `unresolvedIntent()` finds it again next
   Turn and escalates again. Answering is structurally incapable of helping; the fourth escalation
   kills the Conversation.
   ```
   round 1: status=waiting escalations=1 turnCount=1
   round 4: status=failed  escalations=4 turnCount=1
   ```
   It ends `failed` having never taken a Turn after the crash.

2. The transcript carries an assistant tool call with no tool result. Fed through the **real**
   `OpenAiProvider` and `AnthropicProvider` with a recording `fetchImpl`, it produces bodies both
   APIs reject — OpenAI requires a `tool` message per `tool_call_id`, Anthropic a `tool_result` per
   `tool_use`:
   ```
   tool call ids  : [ 'conversation_dm-12:2' ]
   tool result ids: []
   ```
   With `LLM_PROVIDER=openai` or `anthropic` this Conversation cannot reach the model at all.

**Expected** — ADR-0015 caps escalation at three so that *"a persistent outage answered with 'try
again' cannot produce one question per attempt"*, which only makes sense if answering can change
the outcome. And D-017 states the transcript rule broken here; the fix it applied to the `pending`
path was never applied to this one, which the same review created.

---

<a id="bug-12"></a>
## BUG-12 — Calling a **disabled** Assistant strands both Conversations, silently

> **Status (2026-08-10): Fixed.** `assistant.call` resolves the callee and refuses a missing or disabled one as a tool error, before any child is born.

**Severity** high · **Component** runtime/tools + runtime/watcher

**Repro** `-t "births a child nothing will ever advance"` — the Receptionist calls
`assistant.call:accountant` where `accountant` exists with `enabled: false`, then five full scans.

**Observed**

```
parent: waiting assistant
child : running turnCount 0
open questions raised: 0
```

Five scans, zero continuations, zero Open Questions, heartbeat green each time. Neither the tool
registry nor `callAssistant` checks the callee is enabled, so the child is born; then scan 2 filters
`waitingFor` ∈ {user, tool} and skips the parent, scan 5 needs the child `done`/`failed`, and scan 6
skips Conversations whose Assistant is not enabled (`watcher.ts:481`). Nothing can move either one.

**Expected** — exactly what ADR-0015 forbids: *"A failed state must never be somewhere a
Conversation falls"*; *"a stuck Conversation appears in the same view as everything else"*. Either
`assistant.call` should refuse a disabled callee as a tool error the model can correct, or the birth
should be refused and escalated.

---

<a id="bug-13"></a>
## BUG-13 — `thingstore.search` returns an arbitrary subset, not "the most recent ones"

> **Status (2026-08-10): Fixed.** `thingstore.search` orders `createdAt` DESC, which is what its description always claimed, and refuses a limit above one page instead of silently clamping it.

**Severity** high · **Component** runtime/tools

**Repro** `cd runtime && npx tsx ../tmp/hunt/thingstore/09-searchtool.ts` — 12 Invoices created
350 ms apart, `-00` oldest to `-11` newest, one `issuerName`.

**Observed**

```
>>> thingstore.search {"model":"Invoice_DM","field":"issuerName","value":"SRCH-…","limit":5}
  numbers: 03,02,08,10,07
```

Not the newest five, not the oldest five, not a contiguous run. With 40 Things, page 0 and page 3
are equally arbitrary. `ThingRepository.search` (`things.ts:342-349`) never sets `QuerySpec.sort`
and always asks for `pageNumber: 0`; `sort` exists and works (D-016 records the field names) and is
simply never used.

**Expected** — the tool tells the model *"Without a field filter it returns the most recent ones"*
(`tools.ts:186`). It should sort `createdAt DESC`, or stop making the claim. An Assistant asked
"what came in recently" gets 25 arbitrary rows; one looking for a specific invoice among more than
`limit` matches concludes it does not exist. `limit: 1000` is silently clamped to 100.

This is BUG-06's root cause on the hot path.

---

<a id="bug-14"></a>
## BUG-14 — A ThingStore rejection reaches the Assistant as a stack trace with the reason removed

> **Status (2026-08-10): Fixed.** `A12RpcError` carries `data.description.default` — where the store actually puts the reason — and `describeForModel` sends the message rather than the stack to the model, while the operator gets the stack in the log.

**Severity** high · **Component** runtime/tools

**Repro** `cd runtime && npx tsx ../tmp/hunt/thingstore/03-toollayer.ts`

**Observed** — the server gives a precise reason:

```
"Document is not valid: … /Party/Name … The field contains one or several unsupported signs.
 ErrorCode: ZeichenNichtImZeichensatz Rule: formalePruefung"
```

What reaches the transcript, and therefore the model's next prompt:

```
>>> thingstore.create {"model":"Party_DM","fields":{"name":"Klinik 🏥","kind":"organisation"}}
<<< Error: A12RpcError: ADD_DOCUMENT failed: Could not create document (code -32002)
    at <anonymous> (/Users/tgartner/git/assistents/runtime/src/a12/client.ts:184:37)
    at Array.map (<anonymous>)
    … eight more frames of absolute host paths
```

Five structurally different mistakes — missing mandatory field, over-length string, unsupported
character, three decimals on an amount, a year-1000 date — all produce the same sentence.
`A12RpcError` is built from `rpcError.message` only and never touches `rpcError.data`;
`describeError` returns `error.stack`.

**Expected** — the reason the store gave. `advance.ts:333` says the error path is *"Recoverable by
the model: it sees the error as a tool result and self-corrects"*. It cannot self-correct from
`Could not create document`; the likely behaviour is retrying identical input until `maxTurns`.
Secondary: the stack trace burns tokens on every failure, is shown to the User in the Conversation
form, and leaks internal filesystem paths into an LLM prompt.

---

<a id="bug-15"></a>
## BUG-15 — Two of the eight detail forms cannot be opened at all, and fail silently

> **Status (2026-08-10): Fixed.** **Cause found**: both form models omitted `content.subHeaderBox`, one of six keys the form engine's `isFormModelContent()` gate requires. Everything this entry lists as ruled out is confirmed irrelevant, and so were `495310a`'s two attempted fixes. Verified in a real browser; the validator now checks all six keys.

**Severity** high · **Component** models / client

**Repro**
1. Log in at <http://localhost:8081>.
2. **Conversations** → click any row. Nothing opens; the row merely highlights.
3. **Runtime** → click the `the-one` row. Same.
4. Open the browser console.

**Observed**

```
[ERROR] core/application Error while loading activity (ID 5)
        Error: Post processing for model "Conversation_FM" failed.
[ERROR] core/application Error while loading activity (ID 13)
        Error: Post processing for model "RuntimeState_FM" failed.
```

Nothing appears in the UI at all — no message, no empty form, no spinner. The other six forms
(Party, Assistant, Document, Invoice, Process, Open question) open normally, so this is
model-specific rather than a general form failure.

**Expected** — README says *"A Conversation's transcript is also stored on the Conversation Thing
and visible in the UI, though as a data grid rather than a transcript view"*. It is not visible at
all: the transcript, the `lastError`, the `finishReason` and the turn count are unreachable from the
web application, which is where the User lives. The `RuntimeState` form is the only UI route to the
pause flag, the watermark and the heartbeat.

**Ruled out** (so the next person need not repeat it): the served models are byte-identical to the
source files (`LIST_MODELS_INTERNAL` compared against `import/models/**` — `served == source ?
True` for all three tested, including a working control); every `elementRef` in both models resolves
to a real field in its document model; model versions are uniform across all 26 models; both models
validate clean under `node import/validate-models.mjs`; `InlineRepeat` with
`enableAdd/enableRemove: false` is not the trigger, because `OpenQuestion_FM` uses the same shape
and opens. `Conversation_FM` is also the only form model carrying a single `cancel` event instead of
the standard Cancel/Edit/Save triple — but `RuntimeState_FM` has the standard triple, so that alone
does not explain both.

---

# Medium

<a id="bug-16"></a>
## BUG-16 — Two concurrent posts with the same idempotency key both land

> **Status (2026-08-10): Fixed.** Posts sharing an idempotency key are chained, so the second one's probe runs after the first has finished. This closes the single-replica window and not a wider one — two Runtime processes would still race, which is why compose runs exactly one.

**Severity** medium · **Component** connector/firefly ·
**Repro** `npx tsx ../tmp/hunt/firefly/06-dup-and-race.ts` (race section)

`postTransaction` probes for the key and then posts; two callers interleaved between probe and post
both create a journal, even with different amounts. Latent today because the Runtime is
single-replica and scans sequentially — but it is the guarantee ADR-0012 and `reconcile()` lean on.

<a id="bug-17"></a>
## BUG-17 — A split's `currencyCode` is silently ignored

> **Status (2026-08-10): Fixed — and the stated cause was wrong.** The connector does send `currency_code`; **Firefly overrides it** from the source account. A split whose currency differs from its account's is now refused with both currencies named. `currencyCode` is also now in the tool's schema, which it never was — no Assistant could express a currency at all.

**Severity** medium · **Component** connector/firefly ·
**Repro** `npx tsx ../tmp/hunt/firefly/*currency*`

A split posted as `50.00 USD` is stored as `50.00 EUR`. No error, no foreign-amount fields, no
conversion. A foreign-currency invoice is booked at the wrong value with nothing to notice it by.

<a id="bug-18"></a>
## BUG-18 — `categoryName` is passed as a name and Firefly silently creates it

> **Status (2026-08-10): Fixed.** `categoryName` is resolved to a `category_id` through `resolveCategoryId`, mirroring `resolveAccountId`. Note the demo Firefly has no categories, so any category an Assistant names now fails by design until something seeds them.

**Severity** medium · **Component** connector/firefly

A typo (`"Medcal"`) becomes a new Firefly category. This is precisely the hazard README and
`firefly.ts` say the connector exists to prevent — *"the connector never passes account names to
Firefly, because Firefly silently creates an account it does not recognise"* — implemented for
accounts and not for categories, on the same request.

<a id="bug-19"></a>
## BUG-19 — A booking the User deleted in Firefly can never be re-made under its own key

> **Status (2026-08-10): Fixed.** A 422 naming a duplicate is parsed, the named journal is fetched, and only if it is really gone is the post retried without the flag. Firefly answers a missing transaction with **401**, not 404 — measured.

**Severity** medium · **Component** connector/firefly ·
**Repro** `npx tsx ../tmp/hunt/firefly/12-delete-and-prefix.ts`

Re-posting under the original key fails `422 Duplicate of transaction #66` — naming a transaction
that no longer exists. The User's correction in Firefly leaves the Assistant permanently unable to
redo the booking it is responsible for, with an error that points at nothing.

<a id="bug-20"></a>
## BUG-20 — Half of the Operations ACCOUNTING.md requires do not exist

> **Status (2026-08-10): Partly fixed, the rest deferred on the record.** `bookkeeping.listTransactions` existed on the connector and was unregistered; it is now an Operation and granted to the Accountant. `reverseTransaction`, `markCleared`, `importStatement` and `exportBooks` do not exist at all and are now marked **deferred** in ACCOUNTING.md with reasons — building four new Operations is feature work, not a bug fix. A test reads that table, so a row that is neither implemented nor deferred fails the build. `reverseTransaction` is the one worth doing next.

**Severity** medium · **Component** runtime/tools

Five of the ten operations ACCOUNTING.md names as required have no Operation: `reverseTransaction`,
the register query / `listTransactions`, `markCleared`, `importStatement`, `exportBooks`.
`listTransactions` exists in the connector and is never registered, so no Assistant can reach it —
which is also why the Accountant cannot check its own past bookings (see BUG-03).

<a id="bug-21"></a>
## BUG-21 — Firefly validation errors reach the model as a stack trace naming IDs it never saw

> **Status (2026-08-10): Fixed.** `postTransaction` rewrites a `FireflyError` from `details.errors`, naming the field in the model's own vocabulary and substituting the account name the model supplied for the internal id it never saw.

**Severity** medium · **Component** runtime/tools

Same shape as BUG-14, on the Bookkeeping side: Firefly's `422` carries per-field `details`, which
are dropped; what survives is a Node stack trace naming internal Firefly account IDs the model was
never given. README line 261 claims the connector *"returns an error the model can correct itself
against"*.

<a id="bug-22"></a>
## BUG-22 — Concurrent search-then-create yields duplicates under one idempotency key

> **Status (2026-08-10): Fixed.** A blank key is refused rather than silently disabling deduplication, an over-long key is refused with the 100-character `exact_match` ceiling named, and racing callers converge on one deterministically chosen Thing.

**Severity** medium · **Component** runtime/tools · **Repro** `npx tsx ../tmp/hunt/thingstore/06-idempotency.ts`

```
=== A: sequential retry with the same key ===   Parties carrying that key: 1   (correct)
=== B: two concurrent calls, same key    ===   Parties carrying that key: 2
=== B2: five concurrent callers          ===   Parties carrying that key: 5
```

Not a visibility problem — a created Thing is findable by its key immediately. `create()` does
search-then-`ADD_DOCUMENT` with no uniqueness constraint behind it, and A12 has no unique index.
Also here: an **empty** idempotency key silently disables deduplication, and a key longer than the
field's `maxLength: 200` fails inside the *lookup query* rather than being caught.

<a id="bug-23"></a>
## BUG-23 — The `runtime` identity can create and modify `Assistant_DM`

> **Status (2026-08-10): Write half fixed; read half open.** The `runtime` identity is refused `-32059` on `Assistant_DM` for both create and modify, enforced by the store rather than by an array inside the LLM-driven process. Detail in the note below. The read half — `thingstore.search` has no read restriction — is deliberately **not** fixed.

**Severity** medium · **Component** thingstore (authorisation) ·
**Repro** `npx tsx ../tmp/hunt/thingstore/05-authz.ts`

> **Write half fixed** ([D-007a](DECISIONS.md)). `import/auth/roles.yaml` defines an
> `ASSISTANT_WRITE` right held by the `admin` and `user` roles and by no machine one, and
> `childAuthorizationDefinition.json` demands it on the `Document Create`, `Document Update` and
> `Document Partial Update` scopes when the target model is `Assistant_DM`. The `runtime` identity
> now gets `-32059` for both `ADD_DOCUMENT` and `MODIFY_DOCUMENT` on an Assistant, and keeps
> `Conversation_DM`, `OpenQuestion_DM` and `RuntimeState_DM`. `just bootstrap` runs as the User
> (`BOOTSTRAP_USER`, default `human`), since it seeds what the User owns. Guarded by three tests in
> `runtime/test/integration/thing-repository.itest.ts`.
>
> **The read half is still open.** `thingstore.search` has no read restriction, so an Assistant
> granted it can still read every other Assistant's system prompt, every Conversation transcript and
> the `RuntimeState`. That needs a policy on the `Query` scope and is not done here.

```
[OK] runtime: ADD_DOCUMENT Assistant_DM (README says User-only) -> "Assistant_DM/1fc1975e-…"
```

The same identity can modify an existing Assistant's `SystemPrompt`, `Enabled`, `MaxTurns` and
`Tools`. README's Things table says `Assistant` is written by *"**User only** — the Runtime reads
it"*, and D-007 justifies withholding `DOCUMENT_DELETE` because it *"turns a hallucinated delete
into a 403 rather than a lost invoice"* — the identical argument applies here and is not made. The
only thing between an LLM and granting itself `bookkeeping.postTransaction` is the `WRITABLE_MODELS`
array enforced inside the same LLM-driven process.

Same root: `thingstore.search` has no read restriction, so an Assistant granted it can read every
other Assistant's system prompt, every Conversation transcript and the `RuntimeState`.

*(D-007's `DOCUMENT_DELETE` and `MODEL_MANAGE` claims were both checked and are true.)*

<a id="bug-24"></a>
## BUG-24 — An Invoice with no number, no issuer, no date and no amount is accepted

> **Status (2026-08-10): Fixed.** `invoiceNumber`, `issuerName`, `issueDate` and `amountGross` carry `requirednessConfig` — `Invoice_OM`'s four identifying columns. Verified against the live store: an empty Invoice is refused, with the reason. `MANDATORY_FIELDS` in the validator keeps it that way.

**Severity** medium · **Component** models

```
>>> thingstore.create {"model":"Invoice_DM","fields":{}}
<<< {"thingId":"719ee09f-…","model":"Invoice_DM"}
```

`Invoice_DM` declares no `requirednessConfig` on any field. `Party_DM` does (on `Name`) and
correctly refuses an empty document; `Process_DM` does (on `Title`). Invoice is the one Model that
feeds a money decision and the one with no mandatory field. Empty Invoices appear in the overview
and in every search result, indistinguishable from real ones. (`AmountGross` correctly refuses
negatives, more than two decimals and absurd magnitudes — but accepts `0`.)

<a id="bug-25"></a>
## BUG-25 — The turns-exhausted escalation asks a question the User cannot act on

> **Status (2026-08-10): Fixed.** The escalation raises the Conversation's own budget by five before asking, so the answer has something to be acted on. ADR-0015 forbids going straight to `failed` here — the turns limit is its own example.

**Severity** medium · **Component** runtime/loop · **Repro** `-t "re-escalates on every answer and kills"`

The max-turns guard returns before anything is reset, so answering leaves `turnCount` at the limit
and the next Turn escalates again. The User is asked three times and the fourth escalation flips the
Conversation to `failed`, `turnCount` still at the limit — not one Turn was ever taken. There is no
way out through the UI either: `Conversation_FM` has no `MaxTurns` control, and cannot be opened at
all (BUG-15). The prompt says *"Answer to tell it what to do next"*; answering demonstrably does
nothing.

<a id="bug-26"></a>
## BUG-26 — `CONVENTIONS.md` instructs the reader to reintroduce the D-019 overview crash

> **Status (2026-08-10): Fixed.** The contradicting sentence is replaced with one that matches the shipped models. Two further inaccuracies in it are corrected: `leftSlot` lives inside `subHeaderBox`, and the three models do carry `rowActionGroup`. Note the impact was overstated — the validator check D-019 added does stop the crash being reintroduced, so the cost was a contributor sent into a failing build.

**Severity** medium · **Component** docs · *Found independently by two hunters.*

`import/models/CONVENTIONS.md` says, eight lines apart:

> (223) Include a `rowActionGroup` — **always** … give it `{"actions": []}` rather than removing it.

> (231) Those three omit **both**: they carry `"leftSlot": []` and no `rowActionGroup` at all.

The shipped models follow the first and contradict the second — all three carry
`rowActionGroup: {"actions": []}` and no `leftSlot`. Acting on line 231 reproduces exactly the
regression D-019 records: *"broke three overviews completely … Open Questions — the application's
landing page — was blank."* README sends every contributor to this file **first**.

*(The validator check D-019 added does bite, and was proven to: removing the key from one model and
from three, and `{}` without an `actions` array, all exit 1.)*

<a id="bug-27"></a>
## BUG-27 — The validator misses an `EnumerationType` on a Runtime-filtered field

> **Status (2026-08-10): Fixed.** Every field annotated `indexed` must be a `StringType` or a `DateTimeType`. Checked for all indexed fields, not only the ones the watcher filters on, because the tool layer exposes filters the watcher does not use.

**Severity** medium · **Component** models ·
**Repro** `cd tmp/hunt/models/vtest && node mutate.mjs 2-enum-for-filtered-field`

Turning `Conversation_DM.f_status` into an `EnumerationType` while keeping `indexed` passes clean:
`26 models checked — 0 error(s), 0 warning(s)`, exit 0. CONVENTIONS.md lists this first among "the
four query rules", prefaced *"These are load-bearing. Breaking one produces a watcher that silently
returns nothing"*. The validator already owns the list of filtered fields and checks the sibling
rule (`indexed`) against it — it just never inspects the field's type. `f_status` is filtered by
four of the six scans.

<a id="bug-28"></a>
## BUG-28 — "The four machine fields, in order" is unenforced

> **Status (2026-08-10): Fixed.** One check covers presence, order and the gap: every `_DM`'s root group must end with the four machine fields in order. That subsumes the Party/Process hole, where the field the runaway guard depends on could be deleted with a green `just test-models`.

**Severity** medium · **Component** models ·
**Repro** `node mutate.mjs 7-machine-fields-out-of-order` / `7b-…` / `7c-machine-field-missing-createdByConv`

All three pass clean, exit 0, not even a warning. Case 7c matters: `watcher.ts:152` reads
`createdByConversationId` off every trigger-eligible Thing for the guard its own comment
describes — *"that is what stops the Runtime feeding on its own output"* — but the validator
requires that field only on `Document_DM` and `Invoice_DM`, while `Party_DM` and `Process_DM` are
equally trigger-eligible. For two of the four, the field the runaway guard depends on can be deleted
with a green `just test-models`.

<a id="bug-29"></a>
## BUG-29 — Following README "Adding a Thing" verbatim produces a model the validator rejects

> **Status (2026-08-10): Fixed.** Both documents say `"user,runtime"`, and `scripts/check-docs.mjs` fails if either ever prescribes a `roles` value without `runtime` again.

**Severity** medium · **Component** docs · **Repro** `node newthing.mjs user` then `node newthing.mjs user,runtime`

README step 1 and CONVENTIONS.md §Header both prescribe `{"name": "roles", "value": "user"}`, and
call it mandatory. Following the recipe exactly:

```
roles = "user"          -> exit 1  ERROR Widget_DM.json: roles "user" does not include "runtime" …
roles = "user,runtime"  -> exit 0  29 models checked — 0 error(s), 0 warning(s)
```

All 26 shipped models use `"user,runtime"`. The documented recipe cannot reach its own step 9.

<a id="bug-30"></a>
## BUG-30 — `just bootstrap` never updates a seeded Assistant

> **Status (2026-08-10): Fixed.** `bootstrap()` reconciles the Assistant seeds on every run, so re-running after an edit applies it. The `RuntimeState` singleton is deliberately left alone — rewriting it would disengage a pause and reset the watermark. The README row now warns that a prompt edited in the UI does not survive the next `just bootstrap`.

**Severity** medium · **Component** ops

**Repro** Edit the Receptionist's system prompt (in the UI, or in
`runtime/src/bootstrap/assistants.ts`), then `just bootstrap`.

**Observed**

```
INFO bootstrap complete {"created":[],"alreadyPresent":["receptionist","accountant","runtime-state"]}
probe still present: true
```

`bootstrap()` is create-if-absent only (`runtime/src/bootstrap/bootstrap.ts:24-27`): it looks up the
idempotency key, and on a hit does nothing. README's own table says *"Re-run after editing the
seeded Assistant definitions"*. Nothing warns; it reports success. The only way to apply an edited
seed is `just clean` / `just demo-reset` — which destroys the books.

---

# Low

<a id="bug-31"></a>
## BUG-31 — A **detached** `assistant.call` rewrites a finished caller's transcript

> **Status (2026-08-10): Fixed.** A child finishing for a caller that has already reached `done` or `failed` is settled with a log line instead of a transcript entry. Scoped to terminal callers only: a parent waiting on something else may still legitimately be owed the answer.
**runtime/watcher** · `-t "appends the child's result to a caller"`. `awaitMode: "detach"` still sets
`parentConversationId`, so scan 5 appends the child's result — as a `kind:"answer"` entry — into a
Conversation already `done`, and writes it back. `watcher.ts:445` says *"A result arriving for a
Conversation that has already moved on is a log line, never a resurrection"*; it declines to re-run
the parent but not to rewrite it.

<a id="bug-32"></a>
## BUG-32 — Ambiguous account names resolve silently to whichever Firefly listed first

> **Status (2026-08-10): Fixed — one sub-claim corrected.** `resolveAccountId` collects all candidates and refuses an ambiguous name, naming each match with its type. Trailing-space duplicates turn out to be impossible (Firefly trims before its uniqueness check); the real cases are a case-only duplicate within one type, and one name under two types.
**connector/firefly** · Two accounts sharing a name, or differing only by case or a trailing space,
resolve to an arbitrary one with no warning. The name→ID resolution exists precisely so the model
cannot address the wrong account.

<a id="bug-33"></a>
## BUG-33 — The chart of accounts handed to the model includes Firefly's internal accounts

> **Status (2026-08-10): Fixed — the second claim was not a bug.** `listAccounts` filters to the bookable types, so Firefly's `initial-balance` account is no longer offered, and `resolveAccountId` inherits the filter. *"Nothing stops a posting against one"* is false: Firefly refuses all three directions with a 422.
**connector/firefly** · `initial-balance` accounts are offered to the Accountant as bookable
accounts. Nothing stops a posting against one.

<a id="bug-34"></a>
## BUG-34 — Emoji and other non-BMP characters are refused by every plain string field

> **Status (2026-08-10): Documented; not fixable here.** Vendor behaviour with no charset configured, not repo configuration, and the escape hatch is vendor-internal. CONVENTIONS.md now states which characters a string field accepts — there was no statement anywhere before. The exempt set is 17 fields across 9 models, not the three named here, so the failure is wider than described. BUG-14's fix does at least make the reason legible to the model now.
**models / thingstore** · `npx tsx ../tmp/hunt/thingstore/02-charset.ts`. Umlauts, ß, €, curly
quotes, en dashes, non-breaking spaces, Cyrillic, Chinese, tabs, backslashes, colons and quotes all
round-trip; emoji fail with `ZeichenNichtImZeichensatz`. Accepted in fields carrying
`noValueValidation: true` (`ExtractedText`, `Notes`, `Summary`), so an invoice body may contain an
emoji but a `Title` derived from it may not. Low alone; it is the realistic way BUG-14 fires.

<a id="bug-35"></a>
## BUG-35 — `thingstore.search` with a field but no value is a hard error

> **Status (2026-08-10): Fixed.** A field search with no value, and a value over the 100-character `exact_match` ceiling, are both refused in the tool's own words. Deliberately not mapped to `undefined_match`: that answers a different question.
**runtime/tools** · `value` is optional in the tool's own schema, so a model omitting it makes a
permitted call and receives a stack trace (`-32057`). Either treat it as "no filter" or return the
tool's own worded error, as the unindexed-field guard correctly does.

<a id="bug-36"></a>
## BUG-36 — A UI save does not maintain the Model's own `updatedAt`

> **Status (2026-08-10): Documented; not fixable in the client.** A12's form engine offers no save hook — the only saga options are an attachment loader and a document-descriptor selector — and the four machine fields are deliberately on no form. CONVENTIONS.md and the README now say that `updatedAt` records the last **Runtime** write and point at `__meta.modifiedAt` for the other question.
**client** · After answering an Open Question in the UI, `__meta.modifiedAt` moved to `20:17:31`
while the Model's `UpdatedAt` stayed at `20:07:04`. README explains that `createdAt`/`updatedAt` are
the project's own fields *because* `__meta` is unsuitable; a UI write leaves the project's field
lying. Nothing currently filters on it, which is the only reason this is low.

<a id="bug-37"></a>
## BUG-37 — A wrong password answers HTTP 500, not 401

> **Status (2026-08-10): Obsolete — not reproducible.** `6dbf021` moved authentication to Keycloak. `/api/user/local/login` no longer authenticates anything: it answers **401 for any credential, correct or not**, and no code in this repository calls it. Nothing to fix.
**client / auth** ·
`curl -X POST http://localhost:8081/api/user/local/login -d '{"username":"admin","password":"nope"}'`
→ `{"status":500,"error":"Internal Server Error"}`. The UI does show the right message; the status
code is wrong, which matters for anything scripting against it. Vendor (A12 local-auth) behaviour.

<a id="bug-38"></a>
## BUG-38 — README "Status and limitations" is false on three counts about the e2e suite

> **Status (2026-08-10): Fixed.** The bullet is rewritten and now names `npx playwright test --list` as the authority rather than stating a count that goes stale on the next test added. The BUGS.md link no longer says "none of them fixed".
**docs** · `cd e2e && npx playwright test --list` → *"Total: 21 tests in 11 files"*, including the
invoice slice and the restart. README claims the suite is still the vendored template's, that there
are no specs for the slice, and that `just test-e2e` / `just test-live` / `just test` "fail as
written" because `e2e` defines no `test` script — it does. D-019 already records the true state.

<a id="bug-39"></a>
## BUG-39 — The README test tables omit `test-integration`

> **Status (2026-08-10): Fixed.** `just test-integration` has a row, and the `just test` row lists all five tiers and says the last three need the stack up. `scripts/check-docs.mjs` fails if a recipe is ever added without one.
**docs** · `just test` is `test-models test-runtime test-integration test-client test-e2e`; README
lists four of the five and has no row for `test-integration` anywhere — the one tier that needs the
stack up.

<a id="bug-40"></a>
## BUG-40 — `just` prints truncated, subjectless descriptions for five recipes

> **Status (2026-08-10): Fixed.** Seven recipes, not five — `495310a` added two. All seven now have a self-contained one-line summary above a blank line, and `demo-reset` says it takes the books with it. Checked mechanically.
**ops** · `just` shows only the last comment line, so multi-line blocks list a sentence tail:
`demo-reset # only reset that is symmetric across both Authorities …` — with no hint that it
**destroys the books**. Also `restart`, `demo-data`, `test`, `test-integration`. README documents
`just` as the way to remember what exists.

<a id="bug-41"></a>
## BUG-41 — The repository tree says ten ADRs; there are fifteen

> **Status (2026-08-10): Fixed.** Fifteen. `scripts/check-docs.mjs` compares every count the README states against `docs/adr/`.
**docs** · README line 408 (`adr/ — ten architecture decision records`) contradicts line 33
(`fifteen architecture decisions`). `docs/adr/` holds 0001–0015, and 0011–0015 are cited elsewhere
in the same README.

<a id="bug-42"></a>
## BUG-42 — The e2e package fails its own lint and format gates, and nothing runs them

> **Status (2026-08-10): Fixed.** Ten errors, not nine. All fixed, and `e2e` is wired into `just check`, which is what makes it stay fixed. One of the ten was introduced by this very run and caught by the new gate.
**ops** · `cd e2e && npm run lint` → exit 1, 9 errors (`no-empty-object-type`, `no-console`,
`import/order`, `import/no-duplicates`, an unused `getPageAs`); `npm run format` → exit 1. `just
check` claims to *"lint everything that has an opinion"* and `e2e/` is the only package with an
eslint config that it skips; `e2e/build.gradle` does not run them either. Both offending files came
in with `e907124`.

<a id="bug-43"></a>
## BUG-43 — Bilingual labels and "model id matches filename" are stated as rules, not enforced

> **Status (2026-08-10): Fixed.** `header.id` is compared to the filename, and `header.labels` must be bilingual as an error rather than a silent pass. Two further defects the entry does not mention remain open and are recorded in the run log: the `Multilingual` object shape (28 occurrences) is still invisible to the label check, and the warning names the file but not the field.
**models** · A field label missing its `de` is only a **warning**; a *header* label missing `de` is
silent, because the check matches the singular key `label` while headers use `labels` — so the
model's own title, the string the navigation shows, is never checked in either language. And
`header.id` is never compared to the filename for FM/OM/AM/QeM (for a `_DM` it surfaces only as
three misleading unrelated errors). The WCF converter writes `<header.id>.json`, so a mismatched FM
ships under a name no application model resolves.

---

# Checked and found correct

Recorded so the next hunt does not repeat it.

- **The A12 query API has no D-017-class grammar problem.** Colon, space, single quote, double
  quote, backslash, `*`, `%`, `_` and `ü` all round-trip exactly through `exact_match`. Idempotency
  keys of the real `<conversationId>:<seq>` shape dedupe correctly.
- **D-016's Firefly colon fix works.** Re-tested with colon, space, umlaut, `#` and prefix-collision
  keys.
- **D-007 is true on both counts.** `DELETE_DOCUMENT` as `runtime` → `-32059`; `POST /api/v2/models`
  → 403 as `runtime` and as `user1`, and only `admin` gets through to model validation.
- **The same-second `createdAt` boundary is safe.** Three Documents created inside one second, all
  with identical `createdAt`, produced exactly one Conversation each against the live Runtime. The
  watermark's real problems are BUG-06 and BUG-08, not granularity.
- **The markdown editor round-trips faithfully.** A probe carrying a table, a hard line break,
  three-level nested lists, an ordered list, a fenced code block, a horizontal rule, escaped
  `*`/`_`, an inline HTML tag and a block quote survived both the source tab and a genuine edit in
  the Lexical visual editor byte-for-byte, apart from `|---|---|` normalising to `| --- | --- |`.
- **Stored `<script>` payloads render inert.** A Party named `<script>alert('xss')</script>` is
  displayed as text in the overview.
- **Delete asks first.** The overview row delete opens a confirmation dialog.
- **The `RuntimeState` singleton is protected in the UI** — no Add button, no delete action.
- **The eight models obey every written CONVENTIONS.md rule.** Mechanically cross-checked: ids match
  filenames, model versions match the table, all eight DMs end with the four machine fields in
  order, no `EnumerationType` anywhere, every indexed field is String or DateTime, zero
  non-bilingual label arrays, money carries `trait: "amount"`.
- **The validator's other 20-odd checks all bite**, with no false positive on any valid model.
- **`thingstore.update` preserves scalars**, and preserves a repeating group when the update does
  not mention it (BUG-05 is specifically about naming the group).
- **`tools.ts`'s `INDEXED` guard is load-bearing and correct** — its table matches the `indexed`
  annotations in all four writable models, field by field.
- **Baselines were green throughout**: `runtime` 40/40, `client` 288/288,
  `node import/validate-models.mjs` 26 models 0/0, `just check` clean, `npm run typecheck` clean.
