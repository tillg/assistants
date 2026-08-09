# Each Model declares one Authority; no fact has two

Several Things also exist inside External Systems — a person in the address book, a payment at the Bank, an invoice's financial consequences in Bookkeeping. Rather than declaring globally that Things are the truth (with External Systems as projections) or the reverse, **each Model declares its own Authority**, under one hard rule: no fact has two Authorities.

Known Authorities: the **Bank** owns payments and balances. The **address book** owns people. **Bookkeeping** owns the books — accounts, transactions, balances, budgets — because the User edits it directly. The **ThingStore** owns what has no external home: documents, Processes, Conversations and Assistants.

## Consequences

- An Invoice splits deliberately: the document and its extracted fields are a Thing; whether it is owed, paid, claimed or reimbursed is Bookkeeping's. "Is this invoice paid?" is answered by Bookkeeping, never by a status field on the Thing.
- Assistants must not cache foreign facts as Thing fields. Where a foreign fact is needed, it is read through the Connector.
- Adding a Model includes naming its Authority. An unnamed Authority is a future disagreement.
