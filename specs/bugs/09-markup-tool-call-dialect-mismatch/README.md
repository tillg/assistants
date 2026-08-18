# 09 — markup detector admits a tool-call dialect the recoverer cannot read

**Severity:** LOW · **Area:** runtime/llm · **File:** `runtime/src/llm/openai.ts`

## Failure scenario
```ts
const MALFORMED_TOOL_CALL = /<tool_call>|<function=/;            // detects EITHER dialect
const MARKUP_CALL = /<function=([A-Za-z0-9_.-]+)>([\s\S]*?)<\/function>/g;  // recovers ONLY <function=>
```
A Qwen/Hermes-family model emits the JSON-in-tag dialect
`<tool_call>{"name":"thingstore__get","arguments":{…}}</tool_call>` with no `<function=` inside.
`MALFORMED_TOOL_CALL` matches (via the `<tool_call>` alternative), so recovery is attempted; but
`MARKUP_CALL` finds nothing, `toolCallsFromMarkup` returns `[]`, and the provider throws
`TransientLlmError`. The trivially-parseable call is never honoured — it burns every `llmMaxAttempts`
retry and then escalates.

## Root cause
The detector admits a dialect the recoverer does not implement, so a detectable-but-unrecoverable
response is a guaranteed retry-until-escalate.

## Fix
Extend `toolCallsFromMarkup` to also parse the `<tool_call>{json}</tool_call>` body via `JSON.parse`
(mapping `name`/`arguments`), so both detected dialects are recoverable. (Narrowing the detector to only
`<function=>` is the alternative, but supporting the common `<tool_call>` JSON dialect is strictly
better for local models.)

## Verification
Unit test in `runtime/test/openai.test.ts`: a response body containing
`<tool_call>{"name":"thingstore__get","arguments":{"docRef":"X"}}</tool_call>` yields one recovered tool
call rather than throwing.
