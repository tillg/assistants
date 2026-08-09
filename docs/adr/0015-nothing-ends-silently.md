# Nothing ends silently

A failed state must never be somewhere a Conversation *falls*. When a Conversation reaches the end of what it can do on its own — retries exhausted, its limit of Turns reached, an Authority refusing again and again — it does not stop and set `failed`. It raises an **Open Question** carrying the error and waits for the User, exactly as it would for any other question.

The payoff is that a stuck Conversation appears in the same view as everything else. There is one place to look, the Open Questions list, and no second error console for the User to remember to check. `failed` then comes to mean only "the User abandoned it" — a state a human chose rather than one the system fell into. Escalation is capped at three per Conversation, so a persistent outage answered with "try again" cannot produce one question per attempt; the fourth time, the Conversation does end.

One failure survives all of this, and it is the one that matters: **the escalation path shares fate with the failures it reports.** If the ThingStore is unreachable, the token flow is broken or the scan loop has thrown, then writing an Open Question is itself the operation that is failing, and the only symptom is that nothing happens. For a system whose promise is "drop an invoice in and a question appears within seconds", that is precisely the failure the User cannot see. So the Runtime stamps a heartbeat at the end of every successful scan, a scan that throws deliberately leaves the previous heartbeat untouched, and the service reports itself unhealthy once the heartbeat is stale. Silence has to be *recorded* silence.

## Consequences

- Only the terminal tier escalates. Transient errors are retried inside the Turn, and errors the model can act on — malformed tool arguments, an undeclared Tool, a Connector's rejection, a failed validation — are appended as tool results so the next Turn sees them and self-corrects. That is free, and it is how most errors are handled.
- `heartbeatAt` is a health signal, not a watermark and not a lock. Watching the Runtime means watching for its absence, which is why the compose healthcheck reads it.
