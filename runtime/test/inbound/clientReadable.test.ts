import { describe, expect, it } from "vitest";

import { buildHarness } from "../support/harness.js";
import type { OperationContext } from "../../src/operations/registry.js";

/**
 * The standing guard on `clientReadable`'s second obligation.
 *
 * The flag makes two claims, and the compiler can check neither: that the Operation does not change
 * anything, and that **its `execute` never reads its `OperationContext`**. The first is checked by the
 * gate. This file checks the second, the only way it can be checked — by calling every
 * `clientReadable` Operation with no context at all and requiring that none of them notices.
 *
 * A browser call has no Conversation, no Assistant and no idempotency key, because it did not come
 * from a Turn. An Operation that reaches for one would get `undefined` in production and fail there;
 * this test is what makes it fail here instead, on the day the flag is added rather than the day a
 * Tile is opened.
 *
 * It runs over the registry rather than over a hand-written list, so an Operation marked
 * `clientReadable` in a later change is covered without anyone remembering to add it here.
 */

/** No context whatsoever — not an empty object, which would still answer property reads. */
const NO_CONTEXT = undefined as unknown as OperationContext;

/** Arguments good enough to get past each Operation's own parsing, per Operation. */
const ARGS: Record<string, Record<string, unknown>> = {
    "bookkeeping.listTransactions": { start: "2026-01-01", end: "2026-12-31", limit: 5 },
    "bookkeeping.getBalance": { account: "Checking" },
};

describe("every clientReadable Operation", () => {
    it("executes with no Conversation behind it", async () => {
        const harness = buildHarness([]);
        const clientReadable = harness.registry.all().filter((operation) => operation.clientReadable);

        // If this ever reads zero the test has quietly stopped testing anything.
        expect(clientReadable.length).toBeGreaterThan(0);

        for (const operation of clientReadable) {
            const outcome = await operation.execute(ARGS[operation.name] ?? {}, NO_CONTEXT);

            expect(outcome.kind, `${operation.name} did not answer with a value`).toBe("value");
        }
    });

    it("is non-mutating, because the flag claims that too", () => {
        const harness = buildHarness([]);

        for (const operation of harness.registry.all().filter((each) => each.clientReadable)) {
            expect(operation.mutating, `${operation.name} is clientReadable AND mutating`).toBe(false);
            expect(
                operation.seed.requiresApproval ?? false,
                `${operation.name} is clientReadable and shipped wanting an approval`,
            ).toBe(false);
        }
    });
});
