# Assistants call each other asynchronously

An Assistant may call another Assistant, and such a call is **always asynchronous**: it is a Trigger that gives birth to a new Conversation, never a synchronous invocation that returns a value. A synchronous call would re-introduce exactly the blocking that ADR-0004 removes — if the called Assistant raises an Open Question, a waiting caller would block for days.

What the caller does next is its own choice: wait for the result, do other work in the meantime, watch the clock and ask the callee what is going on after five minutes, or carry on without the result at all.

## Consequences

- "Waiting for another Assistant" is the same Conversation state as "waiting for the User" — one waiting mechanism, not two.
- A caller that wants to give up or chase needs a notion of elapsed time, so some form of clock-driven continuation is implied.
- A caller can ask a callee about its progress, which means a Conversation's state must be inspectable by other Assistants, not just by the UserInterface.
