# 15 — colored text containing `]` is corrupted on save→reload

**Severity:** MEDIUM (data loss) · **Area:** client/markdown · **File:**
`client/src/components/markdown-editor/markdown/colorTransformer.ts`

## Failure scenario
In Visual mode, select the text `a]b` and apply any color. Serialize→reload (switch to Markdown and
back, or reopen the document). Export emits the text unescaped:
`` :color[${text}]{value="red"} `` → `:color[a]b]{value="red"}`. Import matches with
`/:color\[([^\]]*)\]\{value="([^"]+)"\}/`; the `[^\]]*` capture stops at the first `]` (after `a`), the
following `\]\{value=` then fails (`b` follows), so **no match** occurs and the literal string
`:color[a]b]{value="red"}` is left in the document as plain text — the user sees raw directive markup and
the color is lost. Same for `:color[**a]b**]{…}`.

## Root cause
Export does not escape `]` (or `\`) inside the bracketed text; import's bracket class is not
escape-aware.

## Fix
Escape `\` then `]` in the bracketed text on export, and unescape on import — mirroring the table
transformer's `\|` handling.

## Verification
Unit test (markdown-editor test suite): round-trip of colored `a]b` preserves both the text and the
color.
