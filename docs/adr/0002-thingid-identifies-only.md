# A ThingID identifies only; the Model travels in a ThingRef

The obvious design — and the one first written into the concept — was for the ThingID to reveal the Thing's Model, so an Assistant handed a bare identifier would know what it was holding. We rejected it: the Receptionist must be able to store an incoming document before it knows whether it is an invoice or a reminder, a Thing may later be reclassified, and an A12 model will evolve. In all three cases a Model-bearing identifier would force the identity to change and break every reference held by other Assistants, Conversations and Bookkeeping metadata.

A **ThingID** therefore identifies and nothing more. Where a receiver needs to know a Thing's Model without a round trip, Assistants pass a **ThingRef** (ThingID + Model) — convenience information only; the ThingStore stays the authority.

## Consequences

- Identity is stable across reclassification and model evolution.
- A Model carried in a ThingRef can be stale. Anything that depends on the Model being correct must resolve the Thing.
