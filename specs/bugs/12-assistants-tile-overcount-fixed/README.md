# 12 — Assistants tile "and N more" over-counts when an entry is filtered out

**Severity:** LOW · **Area:** client/dashboard · **Files:**
`client/src/components/dashboard/AssistantsTile.tsx`, `client/src/components/dashboard/useAssistants.ts`

## Failure scenario
`const hidden = assistants.total - assistants.assistants.length;` where `total` is the server's
`fullSize` and `assistants.assistants` is the **post-filter** page (`summarise()` drops any entry whose
`Key`/`Name` is not a string). With 3 assistants where one has a null `Name`, the tile renders 2 rows
and computes `hidden = 3 − 2 = 1` → shows "and 1 more" even though the whole set is already on screen and
nothing more can be revealed.

## Root cause
`hidden` mixes a pre-filter count (`total`) with a post-filter length; filtering shrinks the length but
not the total.

## Fix
Base "more" on paging, not on the post-filter length: compare `total` against the **pre-filter** page
length returned by the query (rows the page actually contained), so a dropped-but-present entry does not
inflate the hidden count.

## Verification
Unit test in `client/src/test/components/dashboard/`: a page whose rows are all present but one is
filtered out yields `hidden = 0` (no "more" line).
