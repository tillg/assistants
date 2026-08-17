# Bugs found while testing this change

Found during the autonomous session of **2026-08-17/18**, by two adversarial reviews of the committed
code and by driving the running stack. Each entry has a reproduction, because a bug report without
one is a rumour.

**Twenty-two findings. Seventeen were reproduced before being fixed.** Severity is about what happens
if it fires, not about how hard it was to find.

The headline: **the security property held under every attack.** `bookkeeping.postTransaction` could
not be reached from a browser by path traversal, percent-encoding, prototype pollution, an allowlist
mistake, or a forged secret — and Firefly's transaction count was identical before and after every
attempt. What the reviews found instead was a route *wider* than intended, and a money renderer that
would blank a tile or state a confident wrong number.

---

## Severe — money shown wrong, or the tile gone

### 1. A blank currency code blanks the tile · `money.ts` · PROVEN · fixed
`new Intl.NumberFormat(…, {style: "currency", currency})` throws `RangeError` for `""` or `"EURO"`
and `TypeError` for `undefined`. There is **no ErrorBoundary anywhere in `client/src`**, so one
account row with a missing currency takes the whole tile down — and possibly more.
**Repro:** `amount("10", "")`.
**Fix:** validate `/^[A-Za-z]{3}$/`, fall back to a decimal format with the raw code appended. A
valid-but-unknown code such as `XYZ` still formats, because `Intl` accepts it.

### 2. Missing data displayed as a real zero balance · `money.ts` · PROVEN · fixed
`Number("")` and `Number(null)` are both `0`, so an absent balance rendered as `0,00 €`. On a books
tile that is the worst available failure: *"we could not read this"* and *"you have nothing"* are the
two sentences that must never be confusable.
**Repro:** `amount("", "EUR")` → `0,00 €`.
**Fix:** non-finite input renders `—`.

### 3. `totals()` merged unrelated rows, and one bad row poisoned the sum · `money.ts` · PROVEN · fixed
Keyed on `row.currency` with no validation: two rows whose currency was `undefined` became one group
whose `currency` was `undefined`, which then hit bug 1 and threw. `"EUR"` and `"eur"` produced two
separate totals for one currency. And a single non-numeric amount made the whole total read `NaN €`.
**Repro:** `totals([{amount:"10",currency:"EUR"},{amount:"5"},{amount:"7"}])`.
**Fix:** skip rows with an invalid currency or a non-finite amount, upper-case the grouping key, and
mark a total that had to skip something rather than under-reporting in silence.

### 4. A `null` payload was accepted as success, then mapped · `useExternalCall.ts` · PROVEN · fixed
Only `undefined` counted as failure, so `{ok:true, outcome:{kind:"value", value:null}}` reached the
tile as `ready` and `rows.map` threw. The hook's own doc says it never throws — true of the hook,
false of the tile it feeds.
**Fix:** `null` is an error; and both tiles now treat a non-array as empty.

### 5. An unparseable date crashed the transactions tile · `TransactionsTile.tsx` · PROVEN · fixed
`format(parseISO(date), "dd.MM.")` throws `RangeError: Invalid time value` on `""`, `null` or
`"2026-08-32"`. Every other field in a booking was rendered defensively; this one was not.
**Fix:** `isValid()` guard, falling back to the raw string.

---

## Severe — the route was wider than intended

### 6. Query-parameter injection into Firefly's URL · `connectors/firefly.ts` · PROVEN · fixed
`start` and `end` were interpolated raw into the query string. Harmless while the only caller was an
LLM we prompt; this change made it reachable by **any authenticated browser user**.
**Repro, against the live stack:**
```
{"start":"2020-01-01","end":"2030-01-01"}          → ids 163 142 132 122 121
{"start":"2020-01-01","end":"2030-01-01&page=2"}   → ids 111 110 100  99  98
```
The smuggled `page=2` took effect. It cannot escape to a different path — everything lands after
`?` — so this is parameter smuggling, not SSRF.
**Fix:** `URLSearchParams` in the connector, **and** `yyyy-mm-dd` validation at the Operation. Two
layers, because the encoding is what makes the property hold regardless of the call graph.

### 7. `limit` was unbounded · `implementations.ts` · PROVEN · fixed
`Number(args["limit"] ?? 25) || 25` had no ceiling, and the connector passed it through. A browser
could ask for a million rows and have the response buffered into **the process that runs the scan
loop** — the one thing the inbox's own doc says must not be put at risk.
**Fix:** clamped to 1..200, and the ceiling is named in the parameter description so an LLM sees it.

### 8. The Firefly token was mounted into the server, which cannot use it · `docker-compose.yml` · fixed
An earlier draft put the Reader on the A12 server; the design moved to the Runtime and the mount
stayed behind. `grep -r firefly server/app/src/main/` returns **nothing** — so the credential that
reaches the books was sitting inside the one container published to the host, read by no code at all.
The comment two lines above it said *"This server holds no Firefly credential"*.
**Fix:** removed, with a comment recording why it must not come back.

---

## Moderate

### 9. The body cap was three times what it claimed · `inbound/server.ts` · PROVEN · fixed
`MAX_BODY_BYTES = 64 * 1024`, compared against `body.length` on a **string** — UTF-16 units, not
bytes. **Repro:** a 120,020-byte UTF-8 body was accepted; a 70,020-byte ASCII one was not.
**Fix:** accumulate `Buffer` chunks and sum `chunk.length`, which also stops a multi-byte character
being split across chunks.

### 10. An over-large body got a TCP reset, reported as our outage · `inbound/server.ts` · PROVEN · fixed
`request.destroy()` ran synchronously after `reject()`, so the socket died before a status could be
written. The caller saw a transport failure; the Java side turned that into
`{"ok":false,"reason":"runtime-unreachable"}` — **a caller's mistake dressed up as our downtime**,
which is exactly the confusion the code elsewhere takes care to avoid.
**Fix:** answer `413` first, destroy on the response's `finish`.

### 11. `%zz` in the path was a 500 with a stack trace · `inbound/server.ts` · PROVEN · fixed
`decodeURIComponent` throws `URIError`, which reached the outer catch. Two promises broken at once:
every refusal on this route is meant to be one indistinguishable `not-allowed`, and an authenticated
caller could mint a free error-level log line per request.
**Fix:** the decode is guarded and an undecodable name is refused like any other.

### 12. Duplicate React keys on flattened splits · both tiles · PROVEN · fixed
A split transaction flattens to several rows sharing one `transactionId`; `AccountsTile` keyed on
`account.name`, and Firefly permits two accounts with the same name. React warns, and rows may be
duplicated or dropped on update.
**Fix:** the index participates in both keys.

### 13. `isEnabled` let result order decide · `inbound/server.ts` · fixed
Searched with `pageSize: 2` and read `[0]`. Two `Operation_DM` Things sharing a key would mean
whichever the store listed first decided whether the door opened.
**Fix:** more than one match refuses, and logs the key and the count.

### 14. The server relayed the Runtime's internal refusal reasons · `ExternalCallOperation.java` · fixed
The HTTP status was ignored and the body passed through verbatim, so a browser could see
`unauthenticated` (the shared secret is wrong) or `internal` (a handler threw) — telling a caller
*which of the two gates* refused it, the exact distinction the Runtime takes care not to reveal.
**Fix:** any non-2xx becomes one `not-available`.

### 15. A zero timeout escaped as a 500 · `RuntimeProperties.java` · fixed
`Duration.ofMillis(0)` throws `IllegalArgumentException`, which is not an `IOException` and so slipped
past the catch. A misconfigured setting would have looked like a server fault.
**Fix:** clamped to 1s..30s.

### 16. An empty shared secret failed in the wrong place · `ExternalCallOperation.java` · fixed
With no secret configured the server sent an empty header and the Runtime refused it as
`unauthenticated` — a component that is supposed to *be* authenticated reporting that it is not,
which sends whoever debugs it looking in entirely the wrong place.
**Fix:** refused at the server, with an error log naming the cause.

---

## Minor, fixed

### 17. A headline placeholder for tiles that can never have a headline · `DashboardTile.tsx`
Both money tiles pass no `headline`, but the loading placeholder rendered unconditionally — a grey
block that appears and vanishes with nothing taking its place. A guaranteed layout jump, and a
contradiction of the file's own rule that a tile with no honest headline shows none.

### 18. A missing description and accounts rendered as a bare arrow · `TransactionsTile.tsx`

### 19. An empty accounts array rendered a completely empty tile body · `AccountsTile.tsx`
Indistinguishable from a styling bug. Both tiles now say when there is nothing to show.

### 20. No client-side deadline · `useExternalCall.ts`
A promise that never settled left a tile loading for ever. Now raced against a timeout.

---

## Test defects — found by reviewing the tests themselves

### 21. Two vacuous assertions · fixed
- `TransactionsTile.test.tsx` "renders the amount unsigned" **could not fail**: the fixture amount is
  positive and `type` is `undefined`, so even a regression to `signed()` would have passed it.
- `AccountsTile.test.tsx` asserted `queryByText(/8\.496/)` — a string nothing in the component could
  produce.

A test that cannot fail is worse than no test, because it reads like coverage.

### 22. `signed()` was dead code with four tests · fixed
Exported, tested, and called by nothing: the tiles deliberately do not use it, because the rows carry
no `type` field. Worse, `money.ts`'s own header asserted "the sign comes from the transaction's
`type`" — false for the data this application actually receives.

---

## Investigated and NOT a bug

Kept because a rejected finding is worth as much as an accepted one — it stops the same thing being
re-reported, and it records the evidence.

- **The security property itself.** Attacked directly against the live stack: path traversal,
  percent-encoding, `__proto__` in the body, a forged secret, and `postTransaction` placed on the
  allowlist. All refused. `registry` is a `Map`, so prototype keys are not reachable; `JSON.parse`
  makes `__proto__` an own property, so `parseArgs` cannot pollute; `timingSafeEqual` is correctly
  guarded for length, header-array and empty-secret.
- **A stale global `tsc`.** Both client agents reported that `npx tsc` resolves a different compiler
  and floods with errors. It does not reproduce: from `client/`, `npx tsc` and
  `./node_modules/.bin/tsc` are both 6.0.3 and both report zero errors. `just check` is sound.
- **`startsWith("liabilit")` on both sides** cannot false-match any account type Firefly returns.
- **The 90-day window** is stable per mount; `subDays` is calendar-based and `format` is local time,
  so Europe/Berlin's DST does not shift it and it is not off by a day.
- **`useExternalCall`'s fingerprint** is stable for both current callers. The risk is latent, not
  live: a future caller passing a `Date` in `args` would refetch for ever.
- **Accessibility of the button variant.** `data-variant` renders on both branches, the accessible
  name survives (`aria-hidden` is on the icon only), and nothing focusable is nested inside the
  anchor.
- **A negative or fractional `INBOUND_PORT`** cannot skip the `INBOUND_SECRET` requirement — only a
  literal `0` does, and `0` means no listener at all.

---

## Left for you

- **`bookkeeping.listAccounts` and `listOpenItems` now disagree about what a liability is.**
  `listOpenItems` treats `type === "debt"` as one; the new type filter's `liabilit`-prefix rule does
  not match `debt`. Theoretical on this Firefly instance, which only returns
  `asset|expense|revenue|liabilities` — but the two are one concept implemented twice, and that is how
  BUG-02 happened in the first place.
- **An unknown `type` returns an empty list rather than an error**, so a typo shows "no accounts"
  rather than "you asked for something that does not exist". Defensible either way; I left it
  returning nothing because failing open would put expense accounts on a tile headed *Accounts*.
- **`Receivable from insurer` appears on the Accounts tile**, because Firefly types it `asset` and it
  genuinely is one. See decision 1 in `DECISIONS-AND-ASSUMPTIONS.md`.
