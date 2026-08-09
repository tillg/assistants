# The Runtime polls the ThingStore; there is no second API

The Runtime could have offered an interface of its own — a REST endpoint the UserInterface calls when the User answers a question, a webhook the A12 application fires when a Thing is created. It offers neither. It **polls the ThingStore**: every two seconds it asks which Things have materialised, which Open Questions have been answered, and which Conversations are due to wake.

The reason is [ADR-0006](0006-one-authority-per-fact.md). The ThingStore is the Authority for Conversations, Open Questions and everything else that constitutes pending work, so "is there anything to do?" is a question about the store, and nothing else is entitled to answer it. Waiting is therefore a query. An API on the Runtime would be a second place to ask the same question, and it would hold in memory — a pending request, a subscription, a callback — exactly the live state [ADR-0004](0004-assistants-suspend-and-resume.md) exists to remove.

## Consequences

- The User answers by **editing a Thing**: the Open Question is opened in the ordinary A12 form, filled in and saved. There is no custom client code, no button that calls the Runtime, and nothing in the UserInterface that knows the Runtime exists.
- Every way of waking a Conversation goes through the same door, because all of them are a Thing changing in the store — the User answering, a Manual Connector reporting back, one Assistant returning a result to another, a clock expiring.
- The cost is a handful of indexed queries every two seconds, and the latency is the scan interval. At one household's volume that is free; at another scale it would not be, and the polling interval is the first thing that would have to give.
