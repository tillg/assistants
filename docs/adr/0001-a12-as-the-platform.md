# A12 as the platform for Things, ThingStore and UserInterface

For a single-household administrative system, a full enterprise modelling platform looks like heavy machinery — a reasonable reader would expect plain files plus git, or SQLite plus a small web app. We nevertheless build on **A12**: Things are A12 documents governed by A12 models, the `ThingStore` is an A12 Data Service exposing its JSON-RPC interface, and the `UserInterface` is an A12 web application. The reason is modelling rigour, not convenience — A12 is the strongest systematic we have for defining and evolving the models that every Thing conforms to, and model quality is the load-bearing property of this system.

## Consequences

- The three commitments are not equally binding. **A12 models for Things** is the decision that carries the value and the lock-in. **A12 Data Service as ThingStore** follows from it. **The A12 web application as UserInterface** is the loosest coupling and the cheapest to replace later.
- Operational weight (deployment, upgrades) is accepted as the price of model rigour.
