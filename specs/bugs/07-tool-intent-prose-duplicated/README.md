# 07 — assistant prose is copied onto every tool-intent and replayed N times

**Severity:** MEDIUM · **Area:** runtime/llm · **File:** `runtime/src/loop/advance.ts`
(the `for (const call of response.toolCalls)` loop; replay in `buildMessages`)

## Failure scenario
When a Turn returns narration plus several tool calls — content `"Let me look up both accounts"` and
`toolCalls: [search Party, search Invoice]` — the loop writes one `tool-intent` entry per call, each
carrying the **same** `response.text`. `buildMessages` then turns each intent into its own `assistant`
message repeating that prose:

```
assistant{content:"Let me look up both accounts", tool_calls:[search Party]}
tool{result A}
assistant{content:"Let me look up both accounts", tool_calls:[search Invoice]}  <- prose repeated
tool{result B}
```

Next Turn the model sees its own reasoning duplicated once per call (wasted prompt tokens, misleading
context) and the User sees the same sentence twice. The markup-recovery path makes this more likely: a
recovered Qwen turn returns prose alongside multiple recovered calls.

## Root cause
The Turn already treats "only the first intent carries once-per-Turn data" for usage (the `costEntry`
guard records `response.usage` on the first intent only). The prose was not given the same treatment.

## Fix
Put the prose only on the first intent of the Turn (mirroring the usage guard): subsequent intents get
empty `text`.

## Verification
Unit test in `runtime/test/loop.test.ts` (or `openai.test.ts` wiring): a Turn with prose + two tool
calls writes the prose on the first intent only; `buildMessages` emits it once.
