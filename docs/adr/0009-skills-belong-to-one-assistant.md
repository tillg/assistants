# A Skill belongs to exactly one Assistant

A **Skill** — instructions for the LLM, written as markdown — is attached to a single Assistant and is never shared. The obvious alternative was to make Skills reusable Things referenced by several Assistants, so that knowledge such as "how to read a German doctor's invoice" would exist once. We rejected that: when an Assistant needs another's capability, it **calls that Assistant** ([ADR-0007](0007-assistants-call-each-other-asynchronously.md)).

The reason is that a shared Skill is a shared dependency with no owner. Changing it changes the behaviour of every Assistant referencing it, and nobody is responsible for the consequences. Delegation keeps each Assistant's behaviour explainable from its own definition alone, and makes the Assistant — not the Skill — the unit of competence.

## Consequences

- Capability reuse costs an Assistant-to-Assistant call rather than a reference, so it is asynchronous. That is the price of the boundary.
- An Assistant's behaviour is fully readable from its own Thing: prompts, its own Skills, its Triggers. Nothing is inherited from elsewhere.
- The pressure to share will show up as knowledge that looks duplicated across two Assistants. When it does, the answer is to decide which Assistant *owns* that competence and have the other delegate — not to extract a shared Skill.
