# "Tool" is the provider's word

[CONTEXT.md](../../CONTEXT.md) defined an **Operation** as *"something an External System can do"* and a **Tool** as *"an Operation made available to a particular Assistant"*. Those are a capability and a grant of that capability, and they are **both bare nouns** — so nothing in either word says which is derived from the other, and every reader has to memorise the direction. It was tolerable while the grant had no Model to name. [ADR-0019](0019-an-operation-is-a-thing.md) gives the capability one, and a vocabulary that has to be remembered rather than read stops being tolerable at that point.

So the grant becomes a **Granted Operation**: the modifier goes on the derived concept, and the verb is the one the codebase already reaches for everywhere — `grantedTo()`, *"granted to no Assistant"*, ADR-0010's own *"granted Tools"*. **Tool is retired as a domain term.** `ToolDefinition` becomes `GrantedOperation`, `ToolRegistry` becomes `OperationRegistry`, `Assistant.tools[]` becomes `Assistant.grants[]` holding an `OperationKey` per row.

**The word survives at the provider boundary, and only there**: `ToolSchema`, `tools: [...]` in a request, `tool_calls` and `role: "tool"` in a response, `toolNameForLlm` / `operationFromLlm` whose whole job is crossing that boundary, and the `tool-intent` / `tool-result` Entry kinds with their `toolName` / `toolArgs` / `toolResult` fields — those last are also **stored in every existing Conversation**, and renaming them would make old transcripts unreadable to `buildMessages` for no gain. This is the same treatment `docRef` gets: A12's word, kept where we are talking to A12. The rule for new prose and new code is one line — *if the sentence is about an LLM API, "tool" is correct; if it is about what this system can do, it is an Operation.*

That the domain word is **Operation** rather than **Tool** is not tidiness. An External System offers Operations whether or not an LLM exists — Firefly has never heard of one — and `Operation_DM` will outlive this generation of LLM APIs in a way `Tool_DM` would not.

## Considered options

- **`Tool` / `AllowedTool`.** Structurally right: the modifier lands on the derived concept. Rejected on the root word — it would make `Tool_DM` a Model named for an LLM-era API term, put `allowedTools[]` inside the household's machinery, and falsify CONTEXT.md's **External System** entry, which says such a system *"offers Operations"*.
- **`Operation` / `AllowedOperation`.** The same shape as what was chosen, rejected on one word: the codebase's verb is already *grant*, so "allowed" would introduce a second word for a relationship that already has one.
- **Keeping `Operation` / `Tool`.** Free, and the reason it was refused is the first paragraph.
- **Renaming the stored `tool-intent` / `tool-result` Entry kinds too.** Consistency at the price of every existing transcript. The boundary rule is what makes leaving them coherent rather than lazy.

## Consequences

- [ADR-0010](0010-assistants-declare-their-tools.md) keeps its filename and its title — it is cited from six files, and renaming decided history is worse than annotating it. A one-line note there records that what it calls a Tool is now a Granted Operation.
- People will keep saying "tool" and will be understood. The glossary's job is to make the written system unambiguous, not to police speech.
- A half-rename is the failure mode: it is what makes someone ask *"so what is the difference between a Tool and an Operation?"* again in six months. Verification therefore includes accounting for **every** remaining occurrence of the word in `runtime/src`, `import`, `specs/system`, `CONTEXT.md` and `README.md` — each must be the provider boundary, stored data, or an ADR's decided history.
