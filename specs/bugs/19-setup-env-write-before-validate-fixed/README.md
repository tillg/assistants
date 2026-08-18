# 19 — `setup-env.mjs` writes `.env` before validating, poisoning it on a bad template

**Severity:** LOW (latent) · **Area:** scripts · **File:** `scripts/setup-env.mjs`

## Failure scenario
```js
writeFileSync(ENV_FILE, text);   // write happens FIRST
...
if (leftover.length > 0) {        // validation happens AFTER
    ...
    process.exit(1);
}
```
If `.env.example` ever contains a `CHANGE_ME_GENERATED` placeholder that doesn't match the exact
substitution shape (e.g. double-quoted, or with a trailing comment), the regex leaves it unsubstituted.
The script writes the broken `.env` anyway, *then* exits 1. On the next `just setup`, the
`existsSync(ENV_FILE)` guard says ".env already exists — leaving it alone" and exits 0, so the poisoned
`.env` (real secrets plus a literal `CHANGE_ME_GENERATED`) is permanent until the user manually
`rm .env`. Its sibling `render.mjs` deliberately does the opposite ("write nothing until it all
substituted cleanly").

## Root cause
Write-then-validate ordering combined with the (correct) overwrite guard blocks recovery.

## Fix
Move the `writeFileSync` to *after* the `leftover.length > 0` check — validate, then write only on
success.

## Verification
Read-through + reasoning (no fixture harness for setup scripts); the reordered flow writes `.env` only
when substitution is clean, matching `render.mjs`.
