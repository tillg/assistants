/*
 * SPDX-License-Identifier: EUPL-1.2
 *
 * Copyright (c) 2026 Till Gartner
 * Copyright (c) 2012-2026 mgm technology partners GmbH
 *
 * Part of Assistants. Derived from the mgm A12 project template, which mgm
 * licenses as EUPL-1.2 or commercial; Assistants takes the EUPL-1.2 option,
 * so this file is distributed here under EUPL-1.2 only.
 *
 * Licensed under the European Union Public Licence, version 1.2 - see
 * https://eupl.eu/ and the LICENSE file at the root of this repository.
 * Distributed on an "AS IS" basis, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.
 */

/**
 * Clean up after earlier runs — and nothing else.
 *
 * Two rules shape this file:
 *
 *   1. **Never delete a Conversation or an Open Question.** Those are Runtime-owned. Removing one
 *      mid-flight strands a Conversation on a question that no longer exists, and the resulting
 *      failure surfaces three tests later in something unrelated.
 *   2. **Destructive setup runs behind the kill switch.** `RuntimeState.paused` stops the watcher
 *      dead; deleting Things it is scanning without it is how a suite becomes flaky.
 *
 * So this removes only the Things *these tests* created — recognisable by the `E2E` prefix — and
 * leaves the demo household alone.
 */

import { test } from "@playwright/test";

import { E2E_PREFIX } from "../../utils/config";
import { ThingStore } from "../../utils/thingstore";

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * How a leftover Thing of each Model is recognised. Both key on the `E2E` marker, but a Document
 * carries one extra guard, and it exists because of a single hazard: since the letterbox, a
 * `Document`'s `Title` is the **subject line of an arriving email** — untrusted input. Deleting a
 * Document by its `Title` alone would let a forwarded mail whose subject begins `E2E` be silently
 * reclaimed by the next run.
 *
 * So a Document is stale only if its `Title` carries the marker **and** it did not arrive from the
 * ingest — which stamps every Document it creates `Source: email`. That never deletes an ingested
 * Document, whatever the subject says (and so never touches the demo household), while still
 * reclaiming every `E2E`-titled Thing the tests themselves create, whatever `Source` they gave it.
 * `Party` has no untrusted feed, so it stays keyed on its `Name` prefix alone.
 */
const DISPOSABLE: Array<{ model: string; root: string; stale: (body: Record<string, unknown>) => boolean }> = [
    { model: "Party_DM", root: "Party", stale: (body) => str(body.Name).startsWith(E2E_PREFIX) },
    {
        model: "Document_DM",
        root: "Document",
        stale: (body) => str(body.Title).startsWith(E2E_PREFIX) && str(body.Source) !== "email"
    }
];

test("Remove Things left behind by earlier e2e runs", async () => {
    test.setTimeout(120_000);
    const store = await ThingStore.connect("admin");

    await store.withRuntimePaused(async () => {
        for (const { model, root, stale: isStale } of DISPOSABLE) {
            const entries = await store.query(model);
            const stale = entries.filter((entry) => isStale((entry.document[root] ?? {}) as Record<string, unknown>));
            for (const entry of stale) {
                await store.deleteDocument(entry.docRef);
            }
            // eslint-disable-next-line no-console
            console.log(`cleaned ${stale.length} leftover ${model} Thing(s)`);
        }
    });
});
