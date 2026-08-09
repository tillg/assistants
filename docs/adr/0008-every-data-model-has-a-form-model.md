# Every data model has a form model

As soon as an A12 data model exists, a default A12 **form model** is generated for it. Anyone — human, programmer or AI — may then modify that generated form model. There is therefore always a form model for every data model, and it is a stored artefact rather than something derived on the fly.

The alternative was to keep no default at all and generate a form on demand whenever no crafted one exists. That avoids drift, but it also means there is nothing to hand-modify as a starting point, which is the wrong trade for a system whose Assistants are themselves edited through forms ([ADR-0003](0003-assistants-are-things.md)).

## Consequences

- When a data model changes, the system checks that its form model still *works* — that every field the form model references still exists — and can hint to the human that the form model may be worth revisiting. It does not silently regenerate, so hand modifications are never lost.
- That check is one-directional: it catches fields the form model references and the data model no longer has. A newly *added* data-model field that no form model references stays invisible in the UI until someone revisits the form. Accepted, and the hint is what mitigates it.
