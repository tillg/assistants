# 14 — conversation transcript strings are hardcoded English in a localized UI

**Severity:** LOW · **Area:** client/conversation · **Files:**
`client/src/components/conversation/TranscriptHeader.tsx` (and siblings: `Bubble.tsx`, `speaker.ts`,
`PendingQuestion.tsx`, `Receipt.tsx`)

## Failure scenario
The app ships EN + DE and localizes the whole A12 shell (menu, forms, dates), but the custom
conversation components hardcode English and import no localization: e.g. `TranscriptHeader.tsx` renders
`` `called by ${shortId(...)}` `` and the literal `waiting for you`, and the pending-question button
reads `Answer`. With the UI switched to German, the entire transcript and its Answer button stay
English — verified live (menu "Konversationen", form "Antwort", but transcript "waiting for you" /
"Answer").

## Root cause
The conversation components were written with literal English strings rather than localization keys.

## Fix
Route the user-visible transcript strings through the client localization layer
(`client/src/localization`), adding EN + DE resources. Scope this fix to the small set of visible header
/ pending-question strings (`waiting for you`, `called by …`, `Answer`, and the speaker/relation
labels); leave developer-facing glyphs alone.

## Verification
Switch the UI to DE and confirm the transcript header + Answer button render German; EN unchanged.
`client` unit test asserting the strings come from the resource bundle rather than literals.

> Note: this is the one fix in the set whose full scope (every transcript string) is larger than a
> one-liner. The committed fix localizes the primary user-visible header/action strings; any remaining
> minor glyphs are noted for follow-up.
