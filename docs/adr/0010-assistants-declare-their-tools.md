# An Assistant declares the Tools it may use

> **Note, 2026-08-13.** What this ADR calls a *Tool* is now a **Granted Operation** ([ADR-0020](0020-tool-is-the-providers-word.md)), and the rule below has become a conjunction: an Operation is offered when it is **granted** *and* **enabled** in the catalogue *and* **implemented** in the Runtime ([ADR-0019](0019-an-operation-is-a-thing.md)). Both new conditions can only ever remove a capability. The filename and title are kept because they are cited from six files.

Every Assistant's definition names the set of **Tools** — Operations of External Systems — that it is permitted to use. Nothing else is reachable. The alternative was to expose every Operation to every Assistant and rely on prompts and on the User's supervision to keep them in their lane.

We rejected that because supervision is *review*, and review happens after the fact. A prompt saying "never send money" is probabilistic; a declaration is not. The declaration also doubles as documentation: reading an Assistant tells you what it can reach, which is otherwise buried in prose.

## Consequences

- Granularity is the Operation, not the External System. An Assistant can be granted `getBalance` without `sendMoney` on the same Bank.
- Giving an Assistant a new capability is an explicit change to its definition, which is a Thing, so it is visible and reviewable.
- Manual Connectors are not a safety mechanism. They happen to make dangerous Operations harmless today, because a human executes them, and that protection disappears the day a Connector becomes real.
