# Party replaces Person

The concept said **Person**, and the first real scenario broke it. A doctor's invoice is issued by a practice, an insurance claim goes to a company, and the renovation involves a building firm. None of the three is a person, all three need the same fields and the same treatment, and nothing in the system branches on the difference.

**Party** therefore replaces Person everywhere: anyone the household deals with, carrying what kind of thing it is — person or organisation — and what role it plays for us. A Person is simply a Party whose kind is person. Two Models would have duplicated every field in order to express a distinction no Assistant, form or query ever asks about.

## Consequences

- [ADR-0006](0006-one-authority-per-fact.md) gives people to the address book, and that remains the intent for Parties. There is no address book External System yet, so the **ThingStore is the Authority for Parties provisionally**. That is a real, if small, departure from "each Model declares its Authority" — recorded here rather than hidden, and reversed the day an address book Connector exists.
- Until then a Party is created and edited in the UI like any other Thing. When the address book arrives, its facts stop being ours to edit and the Party Model keeps only what is genuinely ours.
