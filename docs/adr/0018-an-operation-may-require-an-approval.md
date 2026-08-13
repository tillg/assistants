# An Operation may require an approval

The README's second paragraph ends *"Nothing is booked without an answer."* Today that sentence is kept by the Accountant's system prompt — *"Never book without an explicit yes"* — and by nothing else. `bookkeeping.postTransaction` is granted and callable on any Turn. [ADR-0012](0012-a-conversation-is-an-intent-log.md) guarantees the same booking cannot land twice; nothing whatsoever guarantees that a *first* booking was approved. The end-to-end tier scripts a model that chooses to ask, so what it proves is suspend-and-resume, not the rule.

[ADR-0010](0010-assistants-declare-their-tools.md) already made the argument in the general case: *"A prompt saying 'never send money' is probabilistic; a declaration is not."* It stopped one step short, at *which* Operations an Assistant may reach, and said nothing about the conditions under which it may reach one. So a `ToolDefinition` may now declare **`requiresApproval`**, and the Runtime refuses the call without one — checked in `advance()`, after the intent is appended and written and before `tools.execute`. That position is chosen so a refusal is *visible in the transcript* rather than inferred from an absence, and so the refusal path is the pending path the loop already has.

**Only the Runtime may raise the approving question, and it is bound to the arguments.** This is the half of the decision that is not obvious, and it is the half that matters. The first draft accepted any answered `confirm` in the Conversation — which would have let a model ask *"shall I file this under Renovation?"*, be told yes, and then post a transaction of any amount to any account. A question the Assistant composed cannot be the thing that constrains the Assistant; it is the prompt again, wearing a data model. So an approval is an answered `confirm` that the **Runtime** raised for this Operation with these arguments, hashed over a canonical form because key order and number formatting arrive as the model produced them.

The cost is accepted deliberately: an Assistant that asks politely of its own accord is not thereby authorised, so **every first booking costs one suspend/resume round trip**. It is one Turn, and it buys a User who always sees the exact arguments they are approving rather than a summary the model chose.

An approval is **consumed by the call it approves**. Two identical bookings therefore need two approvals — the alternative lets one yes place the same transaction twice under two idempotency keys, which is precisely what ADR-0012 exists to prevent. And a **no is terminal** for that Operation with those arguments: the retry gets an ordinary tool error saying the User declined, and no second question is raised. Re-asking someone who has said no is how a safety feature decays into a thing people click through.

Four alternatives were considered and rejected.

**Any answered `confirm` counts** — the first draft, unsound for the reason above.

**The Runtime replays the approved arguments itself** when the answer arrives. Strictly stronger: argument drift becomes impossible and the model cannot substitute anything between the yes and the call. Rejected because it makes the Runtime an actor that posts bookkeeping entries on its own initiative, which is a larger change to what the Runtime *is* than this property is worth, and it breaks the discipline that reconciliation never re-executes. The drift it prevents is cheap to observe — a second, near-identical question — whereas a Runtime that books is not cheap to reason about.

**Returning `error` rather than `pending`.** It would let the next Turn retry, and a model retrying an approval refusal is a model burning Turns against a wall. Pending is what suspension is for.

**The flag on the Assistant rather than the Operation.** It would make the safety property per-Assistant configuration — exactly the probabilistic arrangement ADR-0010 rejected, moved one level up.

## Consequences

- `ToolDefinition` gains `requiresApproval` and `describeCall(args)`. Only `bookkeeping.postTransaction` sets them; `createAccount` would if it were ever granted.
- **The Manual Connectors must never set it.** `bank.sendMoney`, `email.send` and `document.requestText` already suspend on an Open Question because the User *performs* them. An approval there asks the User to approve doing something they are about to be asked to do themselves.
- `Entry` gains `questionId`, stamped by the watcher's answered scan, and an `approval-request` kind carrying `toolName` and `argsHash`. The rendered answer prose is **never parsed** — substring-matching a model-facing string is the failure mode [ASSISTANTS_VS_OPENCLAW.md](../../specs/research/ASSISTANTS_VS_OPENCLAW.md) names as a thing never to start doing. Structured answer fields on `Entry` were rejected as a copy of a fact beside its Authority ([ADR-0006](0006-one-authority-per-fact.md)).
- `describeCall` is the entire user-facing surface of the promise, so it renders a sentence — *"Book €96.50 from Chequing to Renovation, dated 2026-08-12, for invoice INV-233?"* A JSON fallback exists so a missing renderer never blocks the check, and it is not the intended experience.
- The refusal uses `raiseQuestion` directly, never `escalate()`: a missing approval is the ordinary path, and escalating would let three unapproved bookings mark the Conversation `failed`. It sets no `wakeAt` — an unanswered approval waits, it does not lapse into a booking.
- **The end-to-end fixture must be re-scripted.** Its model asks before booking, and that ask no longer counts. That it must change is the demonstration that it was proving the model's manners rather than the rule.
- An approval can be missed by argument drift, producing a second question. Visible and safe; never a wrong booking.
