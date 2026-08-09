# Assistants are Things

An Assistant is prompts, skills and triggers — configuration that a reasonable reader would expect to live in the repository as code, with version control, review and deployment. We decided instead that **an Assistant is a Thing**: it has a Model, a ThingID, and lives in the ThingStore alongside invoices and payments.

The reason is uniformity. The system already has a modelling systematic (A12), a store and a UserInterface driven by form models; making Assistants Things means they are inspectable and editable through exactly those mechanisms, with no second authoring path. It also makes the system self-hosting — an Assistant can be handed a reference to another Assistant.

## Consequences

- The Assistant Model needs prompt fields, which is why A12 models must support **markdown fields** (String plus annotation) and why every Thing needs a **formModel**, crafted or generated.
- Behaviour now lives in the document store rather than in git, so versioning, change history and "how do I roll back a bad prompt" become ThingStore concerns rather than git concerns.
- An Assistant's *definition* being a Thing is separate from its *runtime state*, which is carried by its Conversation (also a Thing).
