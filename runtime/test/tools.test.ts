/**
 * The Operations at their own boundary.
 *
 * `loop.test.ts` drives tools through a scripted model, which is the right shape for testing the
 * loop's branching and the wrong one for testing what a single Operation does with a particular
 * argument. These call `execute` directly, so the assertion is about the Operation's answer rather
 * than about the transcript it ends up in.
 */

import { describe, expect, it } from "vitest";
import { buildHarness, SPECS, type Harness } from "./support/harness.js";
import type { ToolContext, ToolOutcome } from "../src/tools/registry.js";
import type { Assistant, Conversation, Stored } from "../src/domain/types.js";

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
