# Domain — what this change adds and changes

New and changed concepts only. The system's standing domain is
[specs/system/domain.md](../../system/domain.md); the glossary is
[CONTEXT.md](../../../CONTEXT.md). Spelling is British English.

This change adds **no Thing, no Model, no field and no index**. Everything below is vocabulary for
things the store can already be *asked*, and for the one screen that asks them. That is still a domain
concern here: the system's purpose is a human supervising machines, and what the human sees on
arriving decides which of the machines get supervised.

## Vocabulary

| Term | Status | Gloss |
|---|---|---|
| **Dashboard** | **new** | The application's landing page and first menu entry: a grid of **Tiles**, each a summary of one part of the household's admin and a door to the module that holds it. A view over facts that live elsewhere — it holds nothing, computes nothing the store could compute, and is the Authority for nothing |
| **Tile** | **new** | One cell of the Dashboard: an icon, a name, a **Headline**, an optional body, and a destination. Clicking anywhere on it navigates. A Tile is a *view* in App Model terms, so it has its own error boundary — one Tile that cannot load leaves the other three standing |
| **Headline** | **new** | A Tile's one big number. Always a count the ThingStore returned, never a number this application worked out. A Tile that has no honest headline shows none (the **Bookkeeping Tile**) rather than showing an approximation |
| **In flight** | **new** | A Conversation whose work is not over: `status` is `running` **or** `waiting`. The conversations Tile's Headline. Named because *"running conversations"* is the question a User asks and `status = "running"` is not the answer to it — that state lasts a Turn, seconds at a time, while a `waiting` Conversation is where the days go. Derived from one indexed field; not a new state |
| **Waiting on you** | **new** | The actionable subset of In flight: `status = "waiting"` and `waitingFor = "user"` — which is exactly the definition of **Blocked** the previous change gave, counted rather than marked. One number, and the same number as the 🛑 rows in the Conversations overview |
| **createdOn curve** | **new** | How many Documents existed at the end of each of the last twelve months. Built from thirteen counts — a baseline before the window, then one per month — cumulated in the client. Named for the field it is drawn from rather than for what the User reads off it, because the field is the part that constrains it: it is a curve of `createdAt` stamps, not of arrivals, and the two are not the same set. It says whether the household is being fed, which is the one question no overview can answer |
| **createdOn lag** | **new** | The gap between the Documents Tile's Headline and the **createdOn curve**'s last point. `Document.createdAt` is the **Runtime's** field, so a Document created in the web application has none until the next scan stamps it: it counts in the Headline, which constrains nothing, and in no month's bucket. Named because it is visible, and a named discrepancy is a fact while an unnamed one is a bug report |
| **Bookkeeping Tile** | **new** | The one Tile with no number: a labelled door to Firefly III. It cannot have a number, and the reason is architectural rather than unfinished — see below |
| **Dashboard module** | **new** | The App Model navigation module holding the Dashboard's one scene. First in `modules[]`, therefore first in the menu, and the `initialActivity` of the whole application |
| **Conversations module** | **changed** | No longer the landing page. Otherwise untouched |
| **Icon vocabulary** | **extended** | 👦🏼 human · 🤖 AI · 🛠️ tool · 🛑 blocked, plus the Tiles' own 🗣 conversations · 📄 documents · 💰 bookkeeping. The four original glyphs each mean one thing wherever they appear; the three new ones are *labels for places*, which is a different job, and the 🤖 is reused rather than reinvented — every Assistant on the Dashboard is the same 🤖 the Transcript gives it |

## What each Tile asks, and who answers

The point of this table is that every row's Authority column reads *ThingStore* or *Bookkeeping*, and
never *the Dashboard*.

| Tile | Question | Asked as | Authority |
|---|---|---|---|
| 🗣 Conversations | how many are In flight | three counts: `Status = running`; `Status = waiting ∧ WaitingFor = user`; `Status = waiting ∧ ¬(WaitingFor = user)` | ThingStore |
| 📄 Documents | how many exist, and how they grew | one unconstrained count, plus thirteen `date_range` counts on `CreatedAt` | ThingStore |
| 🤖 Assistants | how many, and what are they called | one query for the Assistants themselves — the only Tile that reads documents, because a name is not a count | ThingStore |
| 💰 Bookkeeping | — | nothing | Bookkeeping, and it is not reachable from here |

### Why the Bookkeeping Tile has no number

Worth writing into the domain rather than leaving as an apology, because it is the sharpest
illustration of ADR-0006 in the whole application:

- **Bookkeeping is the Authority** for accounts, balances, budgets and transactions, and nothing in
  this system holds a second copy — deliberately, down to the Invoice having no `paid` field and no
  `bookkeepingRef`.
- **The browser cannot ask it.** Firefly III publishes no port; every browser request goes through
  `firefly-proxy`, which runs its own OIDC flow and forwards `X-Forwarded-Email`. The web application
  holds a Keycloak token for the ThingStore and nothing that Firefly would accept.
- **The one component that could ask it will not be asked.** The Runtime holds Firefly's personal
  access token, and the Runtime offers no API and receives no calls (ADR-0011). Giving it one so a
  tile could show a balance would rebuild exactly the second authority for pending work that ADR-0011
  exists to refuse.

So a balance on the Dashboard would require the Runtime to grow an API, or a Firefly credential to
reach the browser, or this system to cache a foreign fact. All three are things the architecture says
no to. The Tile is a door, it says so, and the User reads the balance from the Authority itself.

## A count is not a fact anyone may keep

The rule this change is really about, stated once:

> **The Dashboard counts; it does not keep.** Every number on it is a `fullSize` the ThingStore
> returned for a query issued moments earlier. No count is stored on a Thing, cached in the client, or
> aggregated anywhere.

The tempting shortcut was a field — `RuntimeState.documentCount`, incremented by the watcher — and it
is wrong for the ordinary reason: it would be a second Authority for a fact the ThingStore already
owns, drifting the first time a Document is deleted outside a scan, and it would put a write on the
Runtime's critical path for a number that exists only to be looked at.

The cost of refusing it is that the Dashboard's numbers are as old as the moment they were read.
Nothing polls (`useThingById`'s rule, and the store already carries the Runtime's two-second scan), so
each Tile states its own read instant, and leaving the Dashboard and returning re-reads it.

## Actors, unchanged

| Fact | Authority | This change |
|---|---|---|
| A Conversation, its status and what it waits on | Runtime | still read-only in the UI; the Tile counts, never writes |
| A Document, and when it was created | User and Runtime, never at the same instant | `CreatedAt` is read for the **createdOn curve**. Nothing stamps it here — the **createdOn lag** is the honest consequence |
| An Assistant, its name and whether it is enabled | **User only** | read for the Tile. The Dashboard has no edit path to any of it |
| Accounts, balances, budgets | Bookkeeping | not read at all, and the Tile says so by having no number |
| How many of anything there are | ThingStore | asked, per visit, and never stored |

The **User** and the **Runtime** are unchanged, and the Runtime does not know the Dashboard exists —
which is the same sentence the previous change ended on, and stays true for the same reason: the
ThingStore is the only integration surface, and this change is one more client of it.
