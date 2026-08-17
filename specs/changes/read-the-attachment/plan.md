# Plan — the free rung first

Ordered so the system is better after step 5 and every step after that is optional. The free,
deterministic reader ships before anything that spends money, which is also the order in which the
two are worth having.

**Dependency on [receive-emails](../receive-emails/):** step 1 of that change (can the Runtime reach
the Content Store?) is a hard prerequisite for *everything* here — both readers need the attachment
bytes. If that spike has not run, run it first; if it came back Stage A, this change is blocked and
should be parked rather than worked around.

## 0. Ground rules

- **Test first**, every step. The readers are pure over bytes and get real PDF fixtures, not
  hand-built objects.
- **No mocking** of the ThingStore or the Content Store — the existing harness is what tests run
  against. The vision API is the one thing not called for real in CI, and it is not mocked either:
  it is the `null` implementation, which is a shipped code path, plus one manual test in step 10.
- **The Receptionist's Skills are not touched.** Only step 2 of its prompt and its grants.

## 1. Fixtures — the thing that decides whether any of this works

Do this first. Every later step is tested against it, and the `MIN_TEXT_CHARS` threshold is
guesswork until this exists.

- [ ] Collect real PDFs under `runtime/test/fixtures/pdf/`, redacted where needed:
      a born-digital utility or telco invoice; a German doctor's invoice with a text layer; a
      **scanned** invoice with none; a scan whose only text is a scanner watermark or fax header
      (the threshold's whole reason for existing); a multi-page statement; an encrypted PDF; a
      corrupt file; something that is not a PDF at all
- [ ] Record for each what is expected: text layer present or not, rough character count
- [ ] **Verify:** the watermark fixture and the born-digital fixture sit on opposite sides of a
      threshold with real daylight between them. **If they do not, stop** — the heuristic needs
      rethinking before any code is written on top of it

## 2. The text-layer reader — pure

- [ ] Add `pdfjs-dist` to `runtime/package.json`; check its licence against `licenses/` and
      `THIRD_PARTY_NOTICES`. Confirm the Node build needs no canvas for **text** extraction
- [ ] Tests first, against every fixture from step 1
- [ ] Implement `readTextLayer(bytes) → { text, pages }` in `runtime/src/readers/textLayer.ts`.
      No store access, no config, no Thing
- [ ] **Verify:** the encrypted and corrupt fixtures return a reason rather than throwing; the
      watermark fixture falls below the threshold

## 3. `document.extractText` as an Operation

- [ ] Tests first, against the harness: writes `extractedText` on a Document whose attachment has a
      text layer; returns `no-text-layer` as a **value** on the scan; **refuses a non-empty
      `extractedText` without `replace`** — mark this one, it is the one that must never be relaxed;
      honours `replace: true`; touches no other field on the Document
- [ ] Implement in `runtime/src/operations/implementations.ts`: `mutating: true`, no
      `clientReadable`, with a `reconcile`
- [ ] **Verify:** a test asserts it is refused by `inbound/gate.ts`, and `just bootstrap` puts it in
      the catalogue

## 4. Wire it into the Receptionist

- [ ] Edit step 2 of the prompt in `bootstrap/assistants.ts` — the (a)/(b)/(c) ladder from
      [architecture.md](architecture.md#the-receptionists-prompt), with the (b) rung written but
      pointing at an Operation that does not exist yet. It will report `unavailable`, which is the
      correct behaviour and is worth seeing early
- [ ] Add `document.extractText` to its grants
- [ ] **Verify:** the diff contains no new Skill, and the two existing Skills are byte-identical

## 5. Extract on arrival

Depends on [receive-emails](../receive-emails/) step 7 being in place.

- [ ] Tests first: a mail with a born-digital PDF produces a Document that **already has
      `extractedText`**; a mail with a scanned PDF produces one with an empty field and no error; a
      reader that throws does not prevent the Document being created
- [ ] Call `readTextLayer` in `watcher/mail.ts` between the upload and `ADD_DOCUMENT`
- [ ] **Verify:** forward a born-digital invoice end to end and confirm the Receptionist classifies
      it **without calling any reading Operation at all**

**Ship-able here.** Stop and take stock before spending anything: most forwarded post should now need
no human. Step 10's measurement is what says whether that is true, and it is worth knowing before
building the paid rung.

## 6. The vision port

- [ ] Define `VisionReader` in `runtime/src/llm/vision.ts` and the `null` implementation
- [ ] Extend `llm/profiles.ts` to read the optional `vision` key; absent ⇒ the null reader
- [ ] Tests first: no `vision` key ⇒ `available === false`; a configured profile with no key in
      `.env` ⇒ a clear startup error, not a runtime surprise
- [ ] **Verify:** `LlmProvider` and its four implementations are untouched in the diff

## 7. The Anthropic implementation

- [ ] Implement `read(pdf, pageCount)`: PDF as a base64 `document` content block, fixed prompt, no
      input from the Document. Return text and `usage`
- [ ] Tests first for the parts that are ours: request shape, the caps, mapping the response, mapping
      an API error to a transient-or-not outcome
- [ ] **Verify:** the request never interpolates anything from the Document or its filename —
      assert it, because this is the injection surface

## 8. `document.readScan`

- [ ] Tests first: returns `unavailable` with the null reader (**the shipped default**);
      `too-many-pages` over `VISION_MAX_PAGES`; refuses a non-empty `extractedText` without
      `replace`; returns `usage`; does nothing when the Operation Thing is `Enabled: false`
- [ ] Implement, with all three caps
- [ ] Add `document.readScan` to the Receptionist's grants
- [ ] **Verify:** with no `vision` profile the whole ladder still works and ends at
      `document.requestText`, exactly as today

## 9. Cost accounting

- [ ] Test first: a Turn that called `readScan` records the Operation's tokens in addition to its
      own
- [ ] Thread `usage` from the outcome into what the Loop Driver records on the Turn
- [ ] **Verify:** a Conversation's recorded cost includes the scan. Without this the spend is
      invisible, which is the failure mode [domain.md](domain.md#cost-becomes-something-an-operation-can-incur)
      exists to prevent

## 10. Manual verification, with real post and real money

- [ ] Configure a `vision` profile and its key
- [ ] Forward a **scanned** invoice. **Verify:** `readScan` runs, the text is right, the Receptionist
      classifies it, the Accountant asks its question, and the answer books correctly
- [ ] Check the recorded cost against the provider's own reported usage. **They should agree**
- [ ] Forward an advertising leaflet. **Verify:** the Receptionist declines to spend on it — and if
      it spends anyway, that is a prompt problem in rung (b), fixed here and not by adding a Skill
- [ ] **Measure the split** over ten real pieces of post: how many needed no reading, how many needed
      `extractText`, how many needed `readScan`, how many still reached a human. Record it in
      `DECISIONS.md` — it is what says whether the paid rung earns its keep

## 11. Documentation

- [ ] `CONTEXT.md`: **Text Layer**, with its `_Avoid_` line
- [ ] `README.md`: the ladder, and the fact that reading a scan costs money and is off by default
- [ ] `specs/system/architecture.md`: the two Operations, the vision port, `pdfjs-dist`, the
      `vision` key in `llm.json`
- [ ] `specs/system/functional.md`: the "In" table — `extractedText` is no longer always supplied by
      a human; and the known-limitations entry saying text extraction is not implemented is now
      **wrong** and must be rewritten rather than deleted
- [ ] `llm.json.example`: the `vision` key, commented, absent by default
- [ ] `DECISIONS.md`: the two-Operations-not-one decision, the narrow port over widening
      `LlmProvider`, no-approval-on-`readScan`, and the step-1 threshold with its calibration
- [ ] **No new ADR.** This change adds no decision of that weight — *arrival may translate but may
      not spend* is a sharpening of receive-emails' ADR-0024 and belongs in that ADR's text, not in
      one of its own

## 12. Close out

- [ ] `just check`
- [ ] Re-read the diff against the promise: **no new Skill**, `LlmProvider` untouched, no native
      dependency, no compose change
- [ ] Note what this surfaced but did not fix — camera photos of receipts being the obvious one — as
      a follow-up, not as scope creep here

## Sequencing at a glance

```
1. fixtures ─┬─→ 2. reader ──→ 3. Operation ──→ 4. Receptionist ──→ 5. on arrival  ◀── SHIPPABLE
             │                                                            │
             └────────────────────────────────────────────────────────────┤
                                                                          ▼
                        6. port ──→ 7. anthropic ──→ 8. readScan ──→ 9. cost ──→ 10. real post
                                                                                      │
                                                                        11. docs ──→ 12. close
```

Step 1 is the one that can invalidate the design — if the threshold cannot separate a real text layer
from scanner noise, the ladder's first rung is unreliable and everything above it inherits that.
Step 10 is the one that says whether the second rung was worth building.
