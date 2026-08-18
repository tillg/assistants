# The Runtime polls the ThingStore; there is no second API

The Runtime could have offered an interface of its own — a REST endpoint the UserInterface calls when the User answers a question, a webhook the A12 application fires when a Thing is created. It offers neither. It **polls the ThingStore**: every two seconds it asks which Things have materialised, which Open Questions have been answered, and which Conversations are due to wake.

The reason is [ADR-0006](0006-one-authority-per-fact.md). The ThingStore is the Authority for Conversations, Open Questions and everything else that constitutes pending work, so "is there anything to do?" is a question about the store, and nothing else is entitled to answer it. Waiting is therefore a query. An API on the Runtime would be a second place to ask the same question, and it would hold in memory — a pending request, a subscription, a callback — exactly the live state [ADR-0004](0004-assistants-suspend-and-resume.md) exists to remove.

## Consequences

- The User answers by **editing a Thing**: the Open Question is opened in the ordinary A12 form, filled in and saved. There is no custom client code, no button that calls the Runtime, and nothing in the UserInterface that knows the Runtime exists.
- Every way of waking a Conversation goes through the same door, because all of them are a Thing changing in the store — the User answering, a Manual Connector reporting back, one Assistant returning a result to another, a clock expiring.
- The cost is a handful of indexed queries every two seconds, and the latency is the scan interval. At one household's volume that is free; at another scale it would not be, and the polling interval is the first thing that would have to give.

## Amendment, 2026-08-18 — [ADR-0023](0023-the-runtime-is-the-door-outward.md)

The Runtime now has **one** inbound surface. It is read-only: `POST /operations/<key>`, on the compose network, behind a shared secret, which executes a named Operation and returns its result — and it is open only where four conditions all hold, two of them read from code rather than from configuration or from a Thing. The title of this ADR is therefore narrower than it reads: there is no second API *for pending work*, and that is the claim the argument above actually makes.

Everything in that argument survives word for word. The ThingStore is still the Authority for Conversations, Open Questions and everything else that constitutes pending work; *"is there anything to do?"* is still a question about the store and nothing else may answer it; waiting is still a query; the Runtime still polls every two seconds for all of it, and the User still answers by editing a Thing. The inbound route carries none of that. It holds no pending request, no subscription and no callback — the live state [ADR-0004](0004-assistants-suspend-and-resume.md) exists to remove — because a synchronous read of a foreign system is over before the next scan begins, and it stores nothing on either side.

What no longer holds is the first consequence above, taken literally: *"nothing in the UserInterface that knows the Runtime exists"*. The Dashboard's two bookkeeping Tiles do know, because the Runtime holds Firefly's credential and the browser holds a Keycloak token Firefly would not accept, so the one component that can answer *"what do the books say?"* had to be reachable. What the client still cannot do through that route is wake a Conversation, answer a question, or change anything at all: it is refused for any Operation that is `mutating`, and there is no path from it into the loop. The sentence at the top of `runtime/src/index.ts` was narrowed in that file in those words rather than deleted, for the same reason this section exists rather than an edit above it.
