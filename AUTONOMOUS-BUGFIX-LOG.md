# Autonomous bug-fix run — decisions and assumptions

Started **2026-08-10**, branch `main`, from commit `6dbf021`.

Task: *verify and fix all the bugs in `BUGS.md`; for every bug first reproduce it, write a test that
reproduces it, commit and push, then fix it until the test passes, commit and push, then move on.*

This file records every decision and assumption made without being able to ask, so they can be
reviewed afterwards.

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
