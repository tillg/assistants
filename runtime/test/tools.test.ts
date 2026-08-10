/**
 * The Operations at their own boundary.
 *
 * `loop.test.ts` drives tools through a scripted model, which is the right shape for testing the
 * loop's branching and the wrong one for testing what a single Operation does with a particular
 * argument. These call `execute` directly, so the assertion is about the Operation's answer rather
 * than about the transcript it ends up in.
 */

import { describe, expect, it } from "vitest";
import { buildHarness, nowIso, SPECS, type Harness } from "./support/harness.js";
import type { ToolContext, ToolOutcome } from "../src/tools/registry.js";
import type { Assistant, Conversation, Stored } from "../src/domain/types.js";

/** What `thingstore.search` and `thingstore.get` return per row. */
interface SearchRow {
    thingId: string;
    model: string;
    fields: Record<string, unknown>;
}

/** Call one Operation the way the loop would, without needing a scripted model. */
async function call(
    harness: Harness,
    operation: string,
    args: Record<string, unknown>,
    overrides: Partial<ToolContext> = {},
): Promise<ToolOutcome> {
    const assistant = await harness.seedAssistant();
    const docRef = await harness.birth({ assistant });
    const conversation = await harness.conversation(docRef);
    const tool = harness.registry.get(operation);
    if (!tool) throw new Error(`No Operation named ${operation}`);
    return tool.execute(args, {
        conversation: conversation as Stored<Conversation>,
        assistant: assistant as Stored<Assistant>,
        idempotencyKey: `${conversation.thingId}:1`,
        ...overrides,
    });
}

describe("thingstore.search", () => {
    it("refuses a field with no value in its own words, rather than throwing", async () => {
        // `value` is optional in the tool's own schema, so a model omitting it makes a *permitted*
        // call. Building `exact_match` with an empty value is not "no filter" — against the live
        // store it produces malformed JSON in the generated predicate and comes back as a bare
        // -32057 whose `data.description` is only "Unexpected error during query execution.", so
        // even a better error channel would leave the model none the wiser. The tool has to guard.
        const harness = buildHarness([]);
        const outcome = await call(harness, "thingstore.search", {
            model: "Invoice_DM",
            field: "issuerName",
        });

        expect(outcome.kind).toBe("error");
        expect(outcome.kind === "error" && outcome.message).toMatch(/value/i);
    });

    it("refuses an explicitly empty value too", async () => {
        const harness = buildHarness([]);
        const outcome = await call(harness, "thingstore.search", {
            model: "Invoice_DM",
            field: "issuerName",
            value: "",
        });

        expect(outcome.kind).toBe("error");
    });

    it("returns the most recent Things, as its own description promises", async () => {
        // The description says "Without a field filter it returns the most recent ones". It never
        // sorted, so the page was whatever the store felt like returning: measured against the live
        // store as 03,02,08,10,07 out of twelve — not the newest five, not the oldest five, not even
        // a contiguous run. An Assistant asked "what came in recently" got arbitrary rows, and one
        // looking for a specific invoice among more than `limit` matches concluded it did not exist.
        const harness = buildHarness([]);
        const t0 = Date.now() - 3_600_000;
        for (let index = 0; index < 6; index += 1) {
            await harness.things.create(SPECS.Invoice_DM, {
                invoiceNumber: `SORTED-${index}`,
                issuerName: "Clinic",
                createdAt: nowIso(new Date(t0 + index * 60_000)),
                idempotencyKey: `sorted-${index}`,
            });
        }

        const outcome = await call(harness, "thingstore.search", { model: "Invoice_DM", limit: 3 });

        expect(outcome.kind).toBe("value");
        const numbers = (outcome.kind === "value" ? (outcome.value as SearchRow[]) : []).map(
            (row) => row.fields.invoiceNumber,
        );
        expect(numbers).toEqual(["SORTED-5", "SORTED-4", "SORTED-3"]);
    });

    it("refuses a limit it could not honour rather than silently truncating", async () => {
        // `limit: 1000` was clamped to 100 with no signal, so a model that asked for everything and
        // got a hundred rows had no way to know it had not seen everything. (The store refuses
        // pageSize 101 outright, so 100 really is the ceiling — the clamp was ours.)
        const harness = buildHarness([]);
        const outcome = await call(harness, "thingstore.search", { model: "Invoice_DM", limit: 1000 });

        expect(outcome.kind).toBe("error");
        expect(outcome.kind === "error" && outcome.message).toMatch(/100/);
    });

    it("still lists Things when no field is named at all", async () => {
        const harness = buildHarness([]);
        await harness.things.create(SPECS.Invoice_DM, {
            invoiceNumber: "NO-FILTER-1",
            idempotencyKey: "no-filter-1",
        });
        const outcome = await call(harness, "thingstore.search", { model: "Invoice_DM" });

        expect(outcome.kind).toBe("value");
        expect(outcome.kind === "value" && (outcome.value as unknown[]).length).toBeGreaterThan(0);
    });
});
