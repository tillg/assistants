# Triggers give birth to Conversations; responses continue them

Waking an Assistant looked at first like one mechanism with several event types. It is two mechanisms, and keeping them apart is load-bearing.

**Birth** is the creation of a new Conversation, and only a **Trigger** does it: the User asks something, a Thing materialises in the system, or an Assistant calls another Assistant. **Continuation** is the resumption of an existing Conversation when the actor it was waiting for responds — the LLM, the User, or a called tool. A response is not a Trigger and never creates a Conversation.

## Consequences

- A Conversation's state is always "waiting for X", which makes the whole system's pending work a query rather than a set of live processes (see ADR-0004).
- External Systems stay out of the Trigger taxonomy. New mail does not trigger anything; the Email Connector *creates a Thing*, and that materialisation is the Trigger. Manual and automated Connectors therefore behave identically.
- Because the three waiting cases are one shape, waiting for the User and waiting for another Assistant need no separate machinery.
