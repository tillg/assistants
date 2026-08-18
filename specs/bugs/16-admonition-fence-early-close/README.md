# 16 — a `:::` line inside a panel body closes the container early on reload

**Severity:** MEDIUM (data loss) · **Area:** client/markdown · **Files:**
`client/src/components/markdown-editor/markdown/admonitionTransformer.ts`,
`client/src/components/markdown-editor/markdown/directives.ts`

## Failure scenario
Insert an admonition/panel and, inside its body, type a line that is just `:::`. Save→reload. The body
is serialized without escaping its own fence lines
(`:::admonition{...}\n${body}\n:::`), and the close regex `CONTAINER_DIRECTIVE_END = /^\s*:::\s*$/` is
matched against every line. On re-import the `MultilineElementTransformer` closes the panel at the
**first** `:::` it meets — the body line — so the body is truncated and the real closing `:::` spills
into the document as stray text. (The alignment transformer already guards this via
`CONTAINS_DIRECTIVE_FENCE`; the admonition transformer does not.)

## Root cause
The admonition export has no bail-out / escaping when its body itself contains a container fence line.

## Fix
Give the admonition export the same `CONTAINS_DIRECTIVE_FENCE` guard the alignment transformer uses:
when the serialized body contains a `:::` fence line, fall back to a non-container serialization (emit
the body as plain content) rather than producing a container that will truncate on import.

## Verification
Unit test (markdown-editor suite): an admonition whose body contains a `:::` line round-trips without
truncation or stray `:::`.
