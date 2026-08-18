# 13 — token footnote renders on a collapsed bubble whose text is hidden

**Severity:** LOW · **Area:** client/conversation · **File:**
`client/src/components/conversation/Bubble.tsx`

## Failure scenario
```tsx
{text !== undefined && (open || !collapsible) && <Text>{text}</Text>}
{recorded > 0 && (
    <Footnote data-role="transcript-cost-footnote">
        {`${format(entry.promptTokens ?? 0)} + ${format(entry.completionTokens ?? 0)} tokens`}
    </Footnote>
)}
```
A collapsed entry (`system`/`prompt`) that also carries usage tokens shows the "N + M tokens" footnote
under its collapsed label while its body text stays hidden — cost detail leaks out of a bubble that is
supposed to be "label and nothing else until asked for." The `text` line is correctly gated by
`(open || !collapsible)`; the footnote is not.

## Root cause
The footnote sits outside the `open || !collapsible` guard that hides the collapsed content.

## Fix
Gate the footnote with the same condition: `recorded > 0 && (open || !collapsible)`.

## Verification
Unit test in `client/src/test/components/conversation/`: a collapsed entry carrying tokens renders no
footnote until expanded.
