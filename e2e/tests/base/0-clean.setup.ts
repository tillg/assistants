/*
 * SPDX-License-Identifier: EUPL-1.2 OR LicenseRef-commercial
 *
 * Copyright (c) 2012-2026 mgm technology partners GmbH
 *
 * Dual License
 * ------------
 * This source file is part of the mgm A12 Platform and available under
 * a choice of two different licenses:
 *
 * 1. Open-Source License - EUPL v1.2
 *    You may redistribute and/or modify this file under the terms of the
 *    European Union Public License, version 1.2 - see https://eupl.eu/.
 *
 * 2. Commercial License
 *    Alternatively, you may obtain a commercial license from
 *    mgm technology partners GmbH, that permits use of this software
 *    under different terms (including support and maintenance services).
 *
 *    Please contact a12-license@mgm-tp.com for more information.
 *
 * You must select and comply with exactly one of the above license options.
 *
 * Warranty Disclaimer (applies to either option)
 * ----------------------------------------------
 * THIS SOFTWARE IS PROVIDED "AS IS" AND WITHOUT WARRANTY OF ANY KIND,
 * WHETHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
 * OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NON-INFRINGEMENT, EXCEPT WHERE SUCH DISCLAIMERS ARE HELD TO BE
 * LEGALLY INVALID. SEE THE RESPECTIVE LICENSE TEXT FOR DETAILS.
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

const DISPOSABLE: Array<{ model: string; root: string; field: string }> = [
    { model: "Party_DM", root: "Party", field: "Name" },
    { model: "Document_DM", root: "Document", field: "Title" }
];

test("Remove Things left behind by earlier e2e runs", async () => {
    test.setTimeout(120_000);
    const store = await ThingStore.connect("admin");

    await store.withRuntimePaused(async () => {
        for (const { model, root, field } of DISPOSABLE) {
            const entries = await store.query(model);
            const stale = entries.filter((entry) => {
                const body = (entry.document[root] ?? {}) as Record<string, unknown>;
                return String(body[field] ?? "").startsWith(E2E_PREFIX);
            });
            for (const entry of stale) {
                await store.deleteDocument(entry.docRef);
            }
            // eslint-disable-next-line no-console
            console.log(`cleaned ${stale.length} leftover ${model} Thing(s)`);
        }
    });
});
