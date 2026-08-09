# Assistants suspend and resume; waiting is never a running process

An Assistant that needs a decision from the User could simply block — keep its agentic loop parked on a pending tool call until the answer arrives. We rejected that, because the User is the supervisor of every activity and may take days to answer, and a construction-permit process waits weeks on an external authority. No waiting period should be represented by a live process.

Instead, an Assistant's state lives entirely in its **Conversation**, which is a Thing. When an Assistant raises a question, that question *is* the current state of its Conversation. The Assistant stops. When the answer arrives the Assistant resumes from its stored Conversation. After a restart, all Open Questions are re-displayed to the User — nothing is lost because nothing was in memory.

## Consequences

- Durability comes from the ThingStore, not from process uptime. Restarting the system is a non-event.
- The UserInterface needs to find all Open Questions across all Conversations, so "awaiting the User" must be a queryable state.
- This composes with **Manual Connectors**: when an External System is fulfilled by the User by hand, its operations are human-paced and asynchronous by nature. Suspend-and-resume is what makes that affordable, and it means the whole system can run end-to-end with every External System manual.
