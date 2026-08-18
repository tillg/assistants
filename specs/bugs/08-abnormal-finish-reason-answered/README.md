# 08 — an abnormal `finish_reason` is silently reported as a successful answer

**Severity:** MEDIUM · **Area:** runtime/llm · **Files:** `runtime/src/llm/openai.ts`,
`runtime/src/llm/anthropic.ts`

## Failure scenario
```ts
finishReason:
    toolCalls.length > 0 ? "wants-tools"
    : choice.finish_reason === "length" ? "length"
    : "answered",          // everything else, incl. content_filter, maps to answered
```
An OpenAI-compatible gateway returns `finish_reason: "content_filter"` (content blocked → empty/partial
content). The provider maps this to `"answered"`, so the loop marks the Conversation `status:"done"`,
`result:""` — a Conversation that produced nothing is recorded as finished successfully. This is exactly
the "did nothing but looks successful" anti-pattern the surrounding code exists to prevent. Anthropic
has the identical shape (`stop_reason` other than `end_turn`/`max_tokens`/`tool_use` → `answered`).

## Root cause
The `finish_reason` switch treats "not length, not tool_calls" as equivalent to a clean stop.

## Fix
Map unknown/abnormal finish reasons (`content_filter`, and any value that is not
`stop`/`length`/`tool_calls` for OpenAI; the Anthropic equivalents) to `finishReason:"error"` with an
error message, so they escalate into an Open Question rather than ending the Conversation `answered`.

## Verification
Unit test in `runtime/test/openai.test.ts`: a response with `finish_reason:"content_filter"` yields
`finishReason:"error"`, not `"answered"`. (Analogous Anthropic test if a fixture exists.)
