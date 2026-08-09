# Exactly one Runtime replica; the lease is crash recovery, not a lock

A Conversation being advanced carries a lease, and it is tempting to read that as mutual exclusion — a second Runtime would see the lease and stay away. It is not, and it cannot be. **A12 has no version, no ETag and no compare-and-swap anywhere**, so reading a lease and writing a new one are two unrelated operations: two Runtimes finding the same expired lease would both proceed, and two writers of one document silently lose one writer's work. The lease is therefore only what lets a later scan pick up a Conversation whose Turn was abandoned by a crash.

Exclusion comes from deployment instead. **Compose runs exactly one Runtime replica**, and that is a constraint of the design rather than a detail of its packaging.

## Consequences

- Every document has exactly one writer at any instant, and the models are arranged around that rule rather than around it being convenient. The Conversation form is **read-only** because the Runtime owns Conversations. The **Open Question is written once by the Runtime**, at the moment it suspends and the conversation is known, and thereafter only by the User — two writers, never at the same time.
- Where the Runtime would otherwise have to touch a document the User may be editing, the state moves to a document the Runtime owns. An answer is consumed by advancing the Conversation, not by stamping the Open Question as consumed.
- Scaling the Runtime out is not a configuration change. It needs A12 to grow a compare-and-swap, or the Runtime to take a lock somewhere that has one.
- Read-only forms are an affordance, not an authorisation boundary. What protects the invariant is that nothing in the UI navigates to those documents in edit mode, not that the server would refuse.
