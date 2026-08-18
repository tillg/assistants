# 17 — a literal `\n` typed in a table cell becomes a newline on reload

**Severity:** MEDIUM (data corruption) · **Area:** client/markdown · **File:**
`client/src/components/markdown-editor/markdown/tableTransformer.ts`

## Failure scenario
Type the two characters `\n` (e.g. in a path `foo\nbar`) into a table cell. Save→reload. Export escapes
*real* newlines to the literal `\n` (`.replace(/\n/g, "\\n")`) but does **not** escape a pre-existing
backslash. Import unconditionally turns every `\n` back into a newline
(`.replace(/\\n/g, "\n")`), so user-authored `\n` is indistinguishable from an escaped newline and is
converted to a real line break. A trailing `\` before a cell delimiter has the analogous effect via the
`(?<!\\)\|` split, merging two cells.

## Root cause
Escaping is not backslash-safe: export escapes newlines and pipes but not the backslash itself, so
import cannot tell an escaped char from a literal one.

## Fix
Escape backslashes first on export (`\` → `\\`, before the `\n`/`\|` escapes), and unescape in reverse
order on import (`\\n`→newline, `\\|`→`|`, `\\\\`→`\`).

## Verification
Unit test (markdown-editor suite): a cell containing the literal characters `foo\nbar` round-trips
unchanged (no newline introduced).
