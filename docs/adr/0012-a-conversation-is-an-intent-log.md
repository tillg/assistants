# A Conversation is an intent log, not a result log

The natural way to write a Conversation is to record what happened: call a tool, receive an answer, append the answer. That loses money. If the Runtime dies between `bookkeeping.postTransaction` returning 200 and the Conversation being written, nothing in the store remembers the call, and the Turn that recovers books the same €184.30 a second time.

So the intent is written **before** the Operation runs. The tool call and its idempotency key are appended to the Conversation and the Conversation is saved; only then is the Operation executed. Recovery finds an intent with no matching result and *asks the Connector whether that key landed* rather than repeating the work. The key is derived from the Conversation and the position of the entry within it, so re-running the same Turn produces the same key.

That works only if every Operation can be asked. The contract is therefore: **every Operation is either read-only or idempotent under a caller-supplied key, and no Operation may be both mutating and unkeyed.** Where the Authority offers no unique constraint of its own, keyed idempotency is achieved by **search-then-act** — look the key up first, and act only on a miss. Bookkeeping carries the key in the transaction's `external_id` and is searched on it. The ThingStore assigns its own identifiers, so creating a Thing is defined as search-then-create on an idempotency key the Thing itself carries.

## Consequences

- A Conversation contains calls that may never have happened. Anything reading one — the User, another Assistant, the loop itself — must treat an intent without a result as *unknown*, never as *failed*.
- Every Model carries an idempotency key field, because search-then-act needs somewhere to search.
- Adding an Operation includes deciding what its key is and how it is searched for. An Operation that mutates and cannot be keyed cannot be added.
