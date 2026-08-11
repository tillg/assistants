# Autonomous bug-fix run — decisions and assumptions

Started **2026-08-10**, branch `main`, from commit `6dbf021`.

Task: *verify and fix all the bugs in `BUGS.md`; for every bug first reproduce it, write a test that
reproduces it, commit and push, then fix it until the test passes, commit and push, then move on.*

This file records every decision and assumption made without being able to ask, so they can be
reviewed afterwards.

---

## If you are picking this up, start here

**Do not trust this file.** It is one agent's account of its own work. The five minutes below are
worth more than reading the rest.

```bash
just demo-reset          # the demo books carry probe leftovers from this run — see Traps
just test                # models, runtime, integration, client, e2e
just check
git log --oneline 6dbf021..HEAD      # 77 commits; each fix commit says what it traded away
```

Everything was green at handoff. If it is not, that is the first thing to know.

### Then, in this order

1. **Review the two changes with the widest blast radius.** Most of the 43 fixes are local. Two are
   not, and both are mine:
   - `runtime/src/watcher/watcher.ts` → `scanMaterialised` (commit `6d695df`). The watermark rule
     changed from "may pass a decided Thing" to "may pass a contiguous run of decided Things", with a
     per-Model frontier and a ceiling. It is the most intricate thing in this run and the easiest to
     get subtly wrong. Read the invariant in the comment, then decide whether you believe it.
   - `import/auth/roles.yaml` + `childAuthorizationDefinition.json` (commit `ea10b01`). A SpEL rule
     against three different resource shapes. It fails **closed** for Assistants and open for
     everything else by design; satisfy yourself that is what it does.

2. **Run `just test-live` against a real LLM.** This is the one thing this run could not do, and it
   is the biggest remaining unknown. `ScriptedProvider` returns fixed arguments, so it cannot pass a
   `thingId` that is created during the run — which means **BUG-03's double-booking guard is
   exercised only by an integration test that hands it the tag directly**, never by the loop. The
   Accountant is now instructed to pass the Invoice's ThingID (`5c50834`); whether a real model
   actually does is unverified. Check the `thing:` tags in Firefly afterwards.

3. **Add the frozen-frontier warning.** A Thing whose creating Conversation never finishes now pins
   its Model's watermark indefinitely — correct (nothing is lost) but invisible. One `log.warn` when a
   frontier stays frozen across consecutive scans turns a silent stall into an operational signal.
   This was recommended during the run and not done.

4. **Then the open work**, in the order I would take it:
   - `reverseTransaction` — a bookkeeping system that cannot reverse a mistake has a real hole, and
     now that `listTransactions` exists the "which transaction" problem is solved. Needs an
     idempotency key and a `reconcile` (ADR-0012), so treat it as a small feature, not a fix.
   - **BUG-23's read half** — `thingstore.search` has no read restriction, so an Assistant can read
     every other Assistant's system prompt and every transcript. Needs a policy on the `Query` scope,
     which is the same mechanism `ea10b01` proved works for writes.
   - **BUG-43's remainder** — the `Multilingual` label shape (28 occurrences) is still invisible to the
     bilingual check, and the warning names the file but not the field.
   - Multi-currency, if wanted: `foreign_amount` + `foreign_currency_code`, and the currency has to be
     enabled in Firefly, which the bootstrap does not do.

5. **Two patterns worth hunting further.**

   **(a) A read-modify-write that sends more than it means.** A12 has no compare-and-swap, so every
   extra field in a payload asserts that field has not changed since you read it. Three places had
   this — one of them a regression I shipped and `just test` caught — and they are written up below.
   `advance.ts` still writes the whole Conversation, which is correct *today* because the Runtime owns
   it exclusively; note that the Conversation form is now openable and its header fields are not
   `readonly`, so a User editing one would be trampled. Worth deciding deliberately rather than by
   default.

   **(b) A test supplying an input the real writer never supplies.** Three of the new defects were the
   same thing — the e2e page object stamping
   `answeredAt`, the e2e helper stamping `CreatedAt`, `FakeFirefly` typing an account `liability`
   instead of `liabilities`. That pattern hid a critical bug each time. A worthwhile next pass: go
   through every fake and test helper and ask, field by field, *who sets this in production?* I did not
   finish that audit.

### Traps that will cost you an hour each

- **It is Rancher Desktop, not Docker Desktop.** Quitting "Docker Desktop" silently does nothing.
- **Its port forwarding dies.** All published ports accept TCP and then close, on every project at
  once. The fix is restarting Rancher Desktop; containers are fine and restarting them does not help.
- **`just restart server` now also restarts the Runtime** (`341f182`) — because the Runtime holds a
  keep-alive pool to the old container IP and every scan fails with a bare `TypeError: fetch failed`,
  with nothing saying why. If you restart the server by hand, restart the Runtime too.
- **`just bootstrap` runs as `human`, not `runtime`** (since `ea10b01`), and it now *overwrites* the
  seeded Assistants — a prompt edited in the web application does not survive it.
- **`pageSize` above 100 is refused by the store**, not clamped. So is an `exact_match` value over 100
  characters — which is *shorter* than the 200-character fields it searches.
- **A red integration test can leak a Firefly transaction**, because `postedIds.push` happens after the
  call the assertion fails on. `e2e/tests/base/0-clean.setup.ts` also cleans `Party_DM` and
  `Document_DM` but not `Invoice_DM`. Hence `just demo-reset` above.
- **The Playwright MCP's allowed root is the pre-rename path** (`git/assistents`), which no longer
  exists, so screenshots have to go to its temp dir and be copied.

---

## The first thing found, which changes the shape of the task

`BUGS.md` says, in its own header, *"Nothing here is fixed. This file is the report, not the
change."* **That is no longer true of the file as it stands on `main`.**

`BUGS.md` was *added* by commit `495310a fix: twelve bugs found by testing the running system`, and
that same commit fixed roughly twelve of the 43 findings. Its message says so explicitly ("Twenty-one
confirmed; twelve fixed here"). So the file was committed already-stale with respect to its own
commit.

**Decision 1.** Every one of the 43 findings is re-verified against today's code before anything is
written. A finding that no longer reproduces is not "fixed by me" — it is recorded as already fixed,
and gets a *regression test* instead of a fix, because in most cases the reason the bug shipped was
that no test covered the behaviour (`BUGS.md` says so itself, repeatedly: "Why no test caught it —
the fake agrees with the bug"). A commit that adds a passing regression test is honest about what it
is; it does not pretend to be a fix.

## Working method

**Decision 2 — the commit cycle.** The requested cycle is followed literally for every finding that
still reproduces:

1. a test that reproduces it, verified **red**;
2. commit + push (the test alone — the tree at that commit genuinely fails);
3. the fix, until the test is **green**;
4. commit + push.

For findings that no longer reproduce, there is one commit: the regression test, green.

**Decision 3 — verification was parallelised, fixing was not.** Six subagents verified the 43
findings concurrently, split by component (firefly / tool layer / watcher / loop / models / docs+ops)
because those file sets are disjoint. The *fixing* is done serially in one process, because the
requested red-then-green commit order cannot be preserved if several agents commit into one working
tree at once. Wall-clock was traded for a git history that means what it says.

**Decision 4 — the Runtime was paused for verification.** `just pause`, so the live watcher would not
react to probe data and confuse one agent's reproduction with another's. It is resumed for the
end-to-end phase.

**Assumption 1.** The live stack that was already up when this run started is the stack to test
against, and its Firefly and ThingStore contents are disposable (`BUGS.md` and the `justfile` both
treat `just demo-reset` as an ordinary operation). Probe data is prefixed `VFY-` so it can be told
apart from demo data.

---

## Baseline, before anything was touched

```
node import/validate-models.mjs   26 models checked — 0 error(s), 3 warning(s)   exit 0
cd runtime && npm test            44/44                                          exit 0
cd runtime && npm run test:integration   51/51                                   exit 0
cd client && npm test             288/288                                        exit 0
```

## Where it ended

```
node import/validate-models.mjs            26 models checked — 0 error(s), 0 warning(s)
node import/validate-models.selftest.mjs   10 validator checks exercised — 0 not enforced
just check                                 clean (now including e2e lint + format, and the docs checker)
cd runtime && npm test                     81 passed   (was 44)
cd runtime && npm run test:integration     65 passed   (was 51)
cd client  && npm test                    288 passed
cd e2e     && npm test                     30 passed   (was 21 collected, 2 fixme, 1 silently skipping)
```

Every tier green, and **nothing skipped or `fixme`d** — which was not true at the start in three
separate places: the two forms BUG-15 broke, and the Invoices guard that had been skipping since the
day it was written.

The `0 warnings` and the "0 not enforced" lines are the two that took real work: the first needed a
regression `495310a` left behind to be undone, and the second needed the validator to be tested
rather than trusted.

---

## Re-verification: the result

Every one of the 43 was re-verified against `6dbf021` before any change. Nine of the findings turned
out to need correcting, which is recorded here because a wrong bug report costs the next reader more
than no report.

| # | Verdict | Correction to the report, where there is one |
|---|---|---|
| 01 | **partially fixed** | The watcher half is fixed (`isAnswered`) and covered by three unit tests. Two halves remain: `e2e/pages/OpenQuestionPage.ts` still stamps `answeredAt` itself, so the suite cannot catch a regression; and the two `reconcile` paths in `tools.ts` still key on the raw field. |
| 02 | **already fixed** | Guarded by no test at all — `FakeFirefly.listOpenItems()` returns `[]` and types `Payables` as the singular `"liability"`, so the fake still agrees with the bug. |
| 03 | live | |
| 04 | live | |
| 05 | live | |
| 06 | live | |
| 07 | **already fixed** | Two narrower same-class windows remain: the re-read is not atomic, and only `paused` is carried forward, so an operator's `watermark` write is still trampled. |
| 08 | live | |
| 09 | **partially fixed** | The reported symptom (the mangled wire name, the false "did not take effect", the duplicate child) is gone. What the report's own *Expected* section calls the compounding problem — `assistant.call` has no `reconcile` at all — was still live. |
| 10 | live | Broader than reported: every Manual Connector, not only `ui.askUser`. |
| 11 | live | |
| 12 | live | |
| 13 | live | `QuerySpec.sort` **does** work against this A12 build, on all eight Models. The `limit > 100` clamp is ours (`tools.ts`), not the store's — the store rejects `pageSize: 101` outright. |
| 14 | live | The reason is always in `rpcError.data.description.default`; `message` is always the same generic sentence. `data.exception` and `data.stacktrace` are always null. |
| 15 | live | **Cause found.** Both models omit `content.subHeaderBox`. The form engine gates every form model on a plain `"key" in content` check over six keys, so a missing key is not a default — the model is unloadable. Everything `BUGS.md` listed as ruled out is confirmed irrelevant, and so are 495310a's two attempted fixes. |
| 16 | live | Firefly places no uniqueness constraint on `external_id`, so the guarantee was only ever advisory. |
| 17 | live | **The reported cause is wrong.** The connector does send `currency_code`; Firefly overrides it from the source account. Also `tools.ts` never exposes `currencyCode`, so no Assistant can express one. |
| 18 | live | `budget_name` behaves the opposite way — Firefly refuses an unknown budget. Only categories auto-create. |
| 19 | live | |
| 20 | live | |
| 21 | live | Firefly often *does* give a usable sentence; what is dropped is **which field** failed, which sits in `details.errors` and is never read. |
| 22 | live | The over-long-key limit is 100 characters on `exact_match`, not the field's `maxLength: 200`. |
| 23 | live | |
| 24 | live | |
| 25 | live | Worse through the real resume path: the scan resumes and immediately re-escalates, so the cap burns two at a time. |
| 26 | live | **Impact overstated.** The crash cannot be reintroduced — the validator gate D-019 added blocks it. The defect is a document contradicting itself, which sends a contributor into a failing build. Two further inaccuracies in the same sentence. |
| 27 | live | |
| 28 | live | |
| 29 | live | |
| 30 | live | The ~10 lines 495310a added to `bootstrap.ts` are unrelated (an `isPaused` helper). |
| 31 | live | |
| 32 | live | **Sub-claim wrong.** Trailing-space duplicates are impossible — Firefly trims before its uniqueness check. The real cases are case-only duplicates within a type, and one name under two types. |
| 33 | **partially** | Internal accounts are offered to the model: live. *"Nothing stops a posting against one"*: **not a bug** — Firefly 422s in all three directions. |
| 34 | live | Vendor behaviour with no charset configured, not repo configuration. The exempt set is 17 fields across 9 models, not the three named. |
| 35 | live | `data.description.default` is `"Unexpected error during query execution."`, so even BUG-14's fix leaves the model none the wiser — the tool itself has to guard. |
| 36 | live | Not fixable in the client: A12's form engine offers no save hook, and the four machine fields are deliberately absent from every form. |
| 37 | **obsolete** | `6dbf021` moved authentication to Keycloak. The endpoint answers 401 for *any* credential, correct or not, and nothing in the repo calls it. |
| 38 | live | Now more wrong than when reported: the suite is 30 tests in 12 files, not 21 in 11. |
| 39 | live | |
| 40 | live | **Seven recipes, not five** — 495310a added two more. |
| 41 | live | Cited line 408 is now line 490, which is itself an argument for a mechanical check. |
| 42 | live | **Ten errors, not nine.** |
| 43 | live | Two further defects on the same check: the `Multilingual` object shape (28 occurrences) is invisible to it, and the warning names the file but not the field. |

**Assumption 2.** `BUGS.md` is treated as evidence to be re-checked, not as ground truth. Where a report
was wrong I fixed the underlying defect and recorded the correction rather than the claim.

### One finding not in BUGS.md

495310a deleted nine `fieldConfiguration.field[]` entries from `Conversation_FM.json`. Three of them
were the only reference to `ToolName`, `ToolArgs` and `ToolResult`, so those fields now have no
presentation configuration at all — which is what the validator's three standing warnings are. They
are the ADR-0008 hint firing correctly. Recorded here because "0 errors, 3 warnings" is not a usable
green signal until it is dealt with.

---

## Decisions taken while fixing, that a reviewer should look at

**Decision 5 — BUG-06 and BUG-08 got one fix, not two.** They are two symptoms of one broken
invariant: "the watermark may only pass a Thing that reached a decision" is not strong enough, because
it says nothing about Things the pass never looked at. The rule is now "a contiguous run of decided
Things". Fixing either alone leaves the invariant false, so splitting them into two fix commits would
have produced a commit that claims to fix something and does not. One red test commit covers both;
one fix commit names both.

**Decision 6 — `thingstore.update` merges group rows by key rather than appending.** BUG-05 asks for
append ("an append-only list of steps"). A plain append has a failure mode a model will actually hit:
read the Process, add a step, send all four rows back, and every row duplicates. Merging by `seq`
satisfies both that and "just the new one", and it also lets a step be corrected. `related` merges by
`thingId`. A group with no declared key still appends.

**Decision 7 — `thingstore.search` refuses an out-of-range limit instead of clamping.** The alternative
was to keep clamping and add a `truncatedTo` field, which changes the shape of the value every
Assistant already reads. Refusing with the ceiling named is consistent with the two other guards on
the same Operation and costs a model at most one Turn.

**Decision 8 — BUG-20: one Operation was implemented, four were marked deferred.** `listTransactions`
existed on the connector and was simply unregistered — that is a gap, and it is closed (and granted to
the Accountant). `reverseTransaction`, `markCleared`, `importStatement` and `exportBooks` do not exist
at all, and building four new Bookkeeping Operations is feature work, not bug fixing. Each is now
marked **deferred** in ACCOUNTING.md with its reason, and the test reads the table so a row that is
neither implemented nor deferred fails the build. **`reverseTransaction` is the one worth revisiting**:
a bookkeeping system that cannot reverse a mistake has a real hole, and now that `listTransactions`
exists the "which transaction" problem is solved. Flagged rather than silently done.

**Decision 9 — BUG-24 made four Invoice fields mandatory, not two.** `invoiceNumber`, `issuerName`,
`issueDate`, `amountGross` — exactly `Invoice_OM`'s identifying columns. The narrower choice (issuer and
amount only) would also stop the reported "empty Invoice accepted", and would be friendlier to a
receipt with no number. I followed the report, because all three demo invoices, the scripted fixture
and the integration tier already supply all four, so nothing legitimate is blocked today. **If a
receipt without a number ever needs recording, `invoiceNumber` is the one to relax.**

**Decision 10 — the validator got a self-test rather than four unverifiable checks.** For BUG-27,
BUG-28, BUG-43 and BUG-24 the shipped models are already correct, so a new check passes the moment it
is written and nothing has been demonstrated. `import/validate-models.selftest.mjs` breaks one rule at
a time in a copy of `import/models/` and requires the validator to reject it — which is how "the
validator misses X" gets a red test at all. It needed one production change, a `MODELS_DIR` override.

**Decision 11 — for prose-only findings there is no automated test, and I said so rather than faking
one.** BUG-26 (a self-contradicting paragraph), BUG-38 (claims about test coverage), BUG-36 and BUG-37
get corrections and no check. Asserting that a README does not contain a particular sentence is
theatre, and asserting a test *count* would make the README fail every time a test is added — worse
than the bug. Four other documentation claims are mechanically checkable and now are, in
`scripts/check-docs.mjs`.

**Decision 12 — BUG-30's fix is destructive in one direction, and that is intended.** `just bootstrap`
now overwrites an Assistant prompt edited in the web application. That is what README asks for, and the
alternative was `just clean`, which destroys the books. It is called out in the README row, because
somebody who edits a prompt in the UI needs to know it will not survive the next `just dev`.

---

## Per-finding record

| # | Verdict | What was done | Commits |
|---|---|---|---|
| 01 | partially fixed | the e2e page object stopped stamping `answeredAt`, so the suite now answers the way a User does; both `reconcile` paths use `isAnswered` | `a6f4a37` test, `31518a1` fix |
| 02 | already fixed | integration guard asserting the plural `liabilities`; the fake's fixture corrected so it stops agreeing with the bug | `3ce6453` test |
| 05 | live | group rows merged by key, not replaced; `steps: []` no longer wipes | `a0ba344` test, `0c3fce2` fix |
| 06 | live | candidates ordered `createdAt` ASC; watermark clamped to a per-Model contiguous frontier | `fcb1c66` test, `6d695df` fix |
| 07 | already fixed | regression guard for the pause; plus a fix for the residual — a forward watermark is carried across the scan's write | `f0b3fa9` test+guard, `f44fc18` fix |
| 08 | live | a skipped Thing freezes its Model's frontier instead of being silently stepped over | `fcb1c66` test, `6d695df` fix |
| 09 | partially fixed | `assistant.call` gained a `reconcile` that reads the child born under the caller's own key | `1d7e242` test, `d55b40c` fix |
| 10 | live | `reconcile` returns `ToolOutcome \| undefined`; the suspended state got one writer, `suspend()` | `f420537` test, `1493e3c` fix |
| 11 | live | an unreconcilable intent gets an `"outcome":"unknown"`, `"retry":false` tool-result | `42f46ae` test, `87e569f` fix |
| 12 | live | `assistant.call` refuses a missing or disabled callee before any child is born | `90ab9aa` test, `61fe8fb` fix |
| 13 | live | search orders `createdAt` DESC; an out-of-range limit is refused with the ceiling named | `8bdf6eb` test, `2ae9950` fix |
| 14 | live | `A12RpcError` carries the store's reason; `describeForModel` keeps the stack out of the prompt | `3716851` test, `709b70d` fix |
| 15 | live | **cause found**: `content.subHeaderBox` missing from both form models. Added, plus a validator check for all six keys the form engine gates on. Verified in a real browser | `2d6aec8` test, and the fix in `2b9be3a`'s sibling model commit |
| 20 | live | `bookkeeping.listTransactions` registered and granted; four Operations marked deferred with reasons | `9e322d7` test, `29953dc` fix |
| 21 | live | a Firefly rejection is rewritten from `details.errors` into the model's own vocabulary | `8fb2d76` test, `8e79c3a` fix |
| 22 | live | blank key refused, over-long key refused, racing callers converge on one Thing | `d6f267a` test, `b6a4b91` fix |
| 24 | live | four Invoice fields made mandatory; `MANDATORY_FIELDS` in the validator | `095f52e` test, `25a8e43` fix |
| 25 | live | the escalation raises the Conversation's own budget by five before asking | `3dd96eb` test, `2e08d48` fix |
| 26 | live | the contradicting sentence replaced with one that matches the shipped models | `1b64e4c` fix |
| 27 | live | every indexed field must be a StringType or DateTimeType | `095f52e` test, `2b9be3a` fix |
| 28 | live | the root group must end with the four machine fields, in order, on all eight DMs | `095f52e` test, `2b9be3a` fix |
| 29 | live | `"user,runtime"` in both documents, and a check so the recipe cannot drift again | `b537443` test, `1b64e4c` fix |
| 30 | live | bootstrap reconciles the Assistant seeds; the RuntimeState is deliberately left alone | `65f4c9c` test, `5bc7e35` fix |
| 31 | live | a child finishing for a terminal caller is a log line, not a transcript entry | `8b24b39` test, `4203ad9` fix |
| 35 | live | a field search with no value, and an over-long value, refused in the tool's own words | `6b1a476` test, `12d73a8` fix |
| 38 | live | the "Status and limitations" bullet rewritten, stating no test count so it cannot go stale | `1b64e4c` fix |
| 39 | live | `just test-integration` documented; the `just test` row lists all five tiers | `b537443` test, `1b64e4c` fix |
| 40 | live | seven recipe summaries made self-contained; `demo-reset` now says it destroys the books | `b537443` test, `1b64e4c` fix |
| 41 | live | fifteen ADRs, and a check against the directory | `b537443` test, `1b64e4c` fix |
| 42 | live | ten lint errors and two format failures fixed; `e2e` wired into `just check` | `7c05bd3` test, `33a8ea1` fix |
| 43 | live | `header.id` compared to the filename; `header.labels` must be bilingual | `095f52e` test, `2b9be3a` fix |
| 03 | live | the `thing:` tag is asked whether this exact posting is already booked, comparing content and never the tag alone | `18b2b83` test, `57d1130` fix |
| 04 | live | `listBudgets(period)` joins `/budgets` with `/budget-limits`; `spent` is a number and never null | `66dca38` test, `b187bf2` fix |
| 16 | live | posts sharing a key are chained, so the second one's probe runs after the first | `18b2b83` test, `57d1130` fix |
| 17 | live | a currency that differs from the account's is refused, and `currencyCode` is exposed to the model at last | `d481fce` test, `6cc8c9a` fix |
| 18 | live | `resolveCategoryId`, mirroring `resolveAccountId` | `8f60b17` test, `5214885` fix |
| 19 | live | a 422 naming a duplicate is checked against the store before retrying without the flag | `18b2b83` test, `57d1130` fix |
| 23 | live | `ASSISTANT_WRITE` in `roles.yaml` + a policy on the three write scopes; bootstrap runs as the User. **Read half deliberately not fixed.** | `ea10b01` |
| 32 | live | all candidates collected; an ambiguous name is refused, naming each match | `d481fce` test, `6cc8c9a` fix |
| 33 | partly | internal account types filtered out of the chart, as a deny-list | `8f60b17` test, `5214885` fix |
| 34 | live | documented in CONVENTIONS.md; not fixable — vendor behaviour | `88e9db7` |
| 36 | live | documented; A12 offers no form save hook that could stamp it | `88e9db7` |
| 37 | obsolete | recorded as not reproducible | `d783b95` |

## Found by doing the work, not in BUGS.md

Four defects this run turned up that no entry covers. Each is fixed.

1. **`495310a` deleted nine `fieldConfiguration` entries from `Conversation_FM`** while hunting
   BUG-15. That was not the cause, and it cost the transcript its three most useful columns
   (`ToolName`, `ToolArgs`, `ToolResult` — which is what the validator's three standing warnings
   were) and made every transcript field editable by the User. Restored: `2368568`. The validator is
   now at **0 errors and 0 warnings**, which matters beyond tidiness — with three standing warnings,
   "0 warnings" could not signal that a *new* unexposed field had appeared.

2. **`just restart server` strands the Runtime**, not only the frontend. The Runtime holds a
   keep-alive pool to the server's old container IP; after a recreate, every scan fails with a bare
   `TypeError: fetch failed`. Measured 51 consecutive failures while a *fresh* process in the same
   container reached the store perfectly well — so it is the pool, and it does not recover on its
   own. The recipe already compensated for the frontend for a sibling reason. Fixed: `341f182`.

3. **Both e2e flow specs asserted `AnsweredAt` was set** — BUG-01's bug written down as an
   expectation. They only passed because the page object filled the field in for the User. Inverted,
   so those two specs are now the guard for the file's critical finding: `3dd1e72`.

4. **The forms-open guard skipped the Invoices module on every run since it was written**, because it
   named the cell value `EUR` and `Invoice_OM` has no currency column. A structural guard coupled to
   demo fixtures, failing silently — which is worse than failing loudly. It now opens the first row,
   whatever it is: `78a296b`.

Two of those four (2 and 4) are the same shape as the findings in `BUGS.md` itself: a real defect
whose only symptom was silence.

## What the end-to-end exploration turned up

Driving the running stack by hand in a browser, and then at volume through the store. Two more
defects, both of which only a live system could show.

5. **BUG-15 was only half fixed by making the forms open.** With the Conversation form finally
   openable, its transcript grid showed five columns — Seq, At, Role, Kind, Text — and a `tool-result`
   row has no `Text`, so *every row where an Operation ran or returned was blank*. Restoring the
   `fieldConfiguration` entries silenced the ADR-0008 warnings because the fields became
   *referenced*; it did not make them *visible*, because a repeating group needs a
   `FieldBasedRepeatOverviewColumn` as well. Two different kinds of "unexposed", and the validator's
   hint can only see the first. Fixed in `0556756`; the transcript now reads end to end.

6. **BUG-03's fix was completely inert.** 30 invoices driven through the live loop produced 39
   postings, 39 distinct journals and zero recognised repeats — correct, but only because the
   `thing:` tag the guard interrogates *was never written*. The scripted transcript passes only
   `groupTitle` and `splits`, and the Accountant's prompt never mentioned `thingId`. So the fix asked
   a question of a field nothing populated. Fixed in `5c50834` by instructing it in the skill and in
   the tool's own description.

That second one is the most useful thing this phase found: a fix that passes its own test and does
nothing in production, because the test supplied the input the system never does.

7. **The User could not start any work at all.** A Document created in the web application stores no
   `createdAt` — the four machine fields are on no form and A12's form engine has no save hook that
   could set one — and the materialised scan constrains on that field with a `date_range`, which
   cannot match an absent value. So a Thing a human creates is invisible to the trigger watcher **for
   ever**. The product's central premise, "a Document arrives and an Assistant notices", failing on
   the one path a human actually uses.

   Found by creating a Document by hand in the browser and watching the Runtime log nothing for
   minutes. Verified against the live store: `CreatedAt`, `UpdatedAt`, `IdempotencyKey` and
   `CreatedByConversationId` all `undefined`, only `__meta.createdAt` set.

   This is BUG-36's mechanism with a far worse consequence than BUG-36 claims for itself. BUG-36 rates
   itself **low** because "nothing currently filters on it" — true of `updatedAt`, and false of
   `createdAt`, which the scan filters on and which is absent for exactly the same reason. The report
   found the mechanism and mis-scoped the blast radius.

   Fixed in `cc938e3`: the materialised scan stamps `createdAt` on any trigger-eligible Thing that has
   none, and the next scan births it through the ordinary path. `createdAt` is the Runtime's own field,
   so this is its owner filling it in, not a special case — and it keeps one code path for birth and
   one meaning for the watermark.

   **Why nothing caught it:** every creation path in the repository stamps the field —
   `ThingRepository.create`, the demo loader, and `createArrivingDocument`, the e2e helper whose entire
   job is to simulate "something arrives". The helper no longer does (`464825f`), so the flagship
   end-to-end spec is now the guard. That is the same defect BUGS.md notes about BUG-01 — "the test
   knows something the User is not told" — in a second place, and both were the same mistake: a test
   supplying an input the system never supplies.

### Verified by hand in a browser

- The **Conversation** and **Runtime** forms open and render completely — transcript, `finishReason`,
  `turnCount`, `Result`, `lastError`, and on the Runtime form the pause toggle, the watermark, the
  live heartbeat and the boundary doc-refs. That is BUG-15's *Expected* satisfied.
- **BUG-24 through the form**: asterisks on exactly the four fields made mandatory, and an empty save
  refused with "This field is required." and a `1 / 4` error navigator. Requiredness put in the Model
  reaches the UI for free — which is why it does not belong in the tool layer.
- **BUG-34 through the form**: an emoji in `Subject` is refused with "The field contains one or
  several unsupported signs", client-side, before any round trip. Exactly as documented.
- A full CRUD cycle: create (refused, then saved), read, search, edit, delete-with-confirmation.
- **BUG-01 at volume**: 30 Open Questions answered with **no** `AnsweredAt`, and all 31 waiting
  Conversations resumed within 40 seconds.
- **BUG-01's own repro, by hand, end to end.** A Document created in the browser, the Accountant's
  question opened in the form, `Confirmed = yes`, an answer typed, **`Answered at` left untouched**,
  Save. The report says "the save lands, and nothing else happens, indefinitely". Observed:

  ```
  13:33:47 stamped createdAt on a Thing that had none   (the new finding, above)
  13:33:47 conversation born  receptionist
  13:33:50 conversation born  accountant
  13:33:54 open question raised  kind=confirm
  13:35:46 scan did work {"births":0,"continuations":1}   <- the answer, with no timestamp
  13:35:48 conversation finished  accountant   turns=4
  13:35:51 conversation finished  receptionist turns=3
  ```

  and afterwards `Confirmed=true`, `AnsweredAt=undefined` — the field is still empty, which is the
  whole point. About two seconds, not never.
- **The watermark at volume**: 30 of 30 Documents got a Conversation. Nothing lost.

### Smaller things noticed, not fixed

- `e2e/tests/base/0-clean.setup.ts` cleans `Party_DM` and `Document_DM` but not `Invoice_DM`, so every
  invoice-slice run leaves an Invoice behind. The Invoices overview is now mostly `2026-118`.
- A *red* integration test can leak a Firefly transaction, because `postedIds.push` happens after the
  call that the assertion then fails on. Six 1.00 EUR journals in the demo books came from exactly
  that during this run.
- Two `RuntimeState` rows exist — `the-one` and `itest`. Not a bug: the integration tier keeps one
  inert fixture per Model and `loadState()` filters on `the-one`. Worth knowing before it looks alarming.

## Still open, deliberately

- **BUG-23's read half.** `thingstore.search` has no read restriction, so an Assistant granted it can
  read every other Assistant's system prompt, every Conversation transcript and the `RuntimeState`.
  Closing it needs a policy on the `Query` scope. Recorded in BUGS.md.
- **BUG-20's four deferred Operations** — `reverseTransaction`, `markCleared`, `importStatement`,
  `exportBooks`. `reverseTransaction` is the one worth building next, and `listTransactions` existing
  now makes it possible.
- **BUG-43's two further defects**: the `Multilingual` object label shape (28 occurrences) is still
  invisible to the bilingual check, and the warning names the file but not the field.
- **Multi-currency** is refused rather than recorded. Doing it properly needs `foreign_amount` +
  `foreign_currency_code` and the currency enabled in Firefly, which the bootstrap does not do.
- **The non-atomic RuntimeState re-read** (BUG-07's deeper half) cannot be closed without
  compare-and-swap, which A12 does not offer.

## A regression I shipped, and what it led to

The `just test` immediately after handoff failed on Party CRUD: a city edited from Köln to Frechen
came back Köln. **I had caused it**, in `cc938e3` — the commit that fixed "the User cannot start any
work".

`stampMissingCreatedAt` wrote `{ ...thing.data, createdAt }`, where `thing.data` is the snapshot the
*search* took. `ThingRepository.update` merges what it is given over the **current** document, so
that snapshot overwrote whatever the User had saved in between. A lost update — and `Party_DM` is
trigger-eligible, a Party created in the UI has no `createdAt`, and the scan runs every two seconds,
so the window is the whole time a human spends typing. Fixed in `1226590` by sending `{ createdAt }`
and nothing else.

Worth stating plainly: the commit that fixed *"the User cannot start any work"* introduced *"the
Runtime silently reverts the User's edits"*. Same file, same day.

**The audit that followed is the useful part.** Treating it as a pattern rather than a typo, I read
every read-modify-write in `runtime/src` and found the same shape twice more, neither of them mine
(`8f7d00d` red, `9bc9723` fixed):

- `setPaused` — the function behind `just pause` / `just resume` — wrote `{ ...state.data, paused }`,
  reverting whatever the scan had advanced in between. The exact mirror of BUG-07: that was the scan
  trampling `paused`; this is the operator flipping the kill switch and silently rolling the watermark
  back, which re-queues every Thing behind it.
- `thingstore.update` wrote `{ ...current.data, ...fields }`, so an Assistant correcting one field
  reverted any edit the User saved in the meantime — and redundantly, since `update` already merges
  over the current document. Its own description says "supply only the fields you are changing"; it
  was preserving the others *as they were at the read*, which is a different and worse promise.

So the rule this codebase keeps re-learning, now written down: **a read-modify-write against A12 must
send the fields it means and nothing else.** There is no compare-and-swap underneath, so every extra
field in the payload is a field you are asserting has not changed.

One process note: the `thingstore.update` test was initially red for the *wrong* reason — it hooked
the first read of any document, and the harness reads a Conversation before the tool reads the Party,
so the competing edit never landed. Corrected, then verified to have teeth by reverting the fix and
watching it go red again. A red test is not evidence until you know *why* it is red.

## Two defects in this run's own work, found by reviewing it

Recorded because they are the kind of thing a reviewer should expect to find, and because both were
the *same mistake the original bugs were made of*.

- the BUG-22 duplicate check ran **after** a successful write and was allowed to throw, so a failed
  *check* would have reported a created Thing as an error. Made non-fatal.
- the BUG-33 account filter was an **allow-list**, which is exactly BUG-02: an allow-list that did
  not know Firefly's plural silently hid the payables account. Mine would have hidden a `cash`
  account, or any type nobody anticipated. Inverted to a deny-list of the three internal types.

Both in `86bd489`.
