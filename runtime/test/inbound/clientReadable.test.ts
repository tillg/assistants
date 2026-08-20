import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildHarness, useFirefly } from "../support/harness.js";
import { FireflyFixture } from "../support/fireflyFixture.js";
import type { OperationContext } from "../../src/operations/registry.js";

/**
 * The standing guard on `clientReadable`'s second obligation.
 *
 * The flag makes two claims, and the compiler can check neither: that the Operation does not change
 * anything, and that **its `execute` never reads its `OperationContext`**. The first is checked by the
 * gate. This file checks the second, the only way it can be checked — by calling every
 * `clientReadable` Operation with no context at all and requiring that none of them notices.
 *
 * Since ADR-0025 the `clientReadable` Operations are dynamic, marked on the Operation Thing rather
 * than in code, so the set is read from the catalogue and each is run through the Operation Host — the
 * same path the inbound door takes, with the same `undefined` context a browser call carries.
 */

/** No context whatsoever — not an empty object, which would still answer property reads. */
const NO_CONTEXT = undefined as unknown as OperationContext;

/** Arguments good enough to get past each Operation's own parsing, per Operation. */
const ARGS: Record<string, Record<string, unknown>> = {
    "bookkeeping.listTransactions": { start: "2026-01-01", end: "2026-12-31", limit: 5 },
};

const fixture = new FireflyFixture();
beforeAll(() => fixture.start());
afterAll(() => fixture.stop());
beforeEach(() => {
    fixture.reset();
    useFirefly(fixture);
});

describe("every clientReadable Operation", () => {
    it("executes with no Conversation behind it", async () => {
        const harness = buildHarness([]);
        const clientReadable = harness.catalogue.filter((operation) => operation.clientReadable);

        // If this ever reads zero the test has quietly stopped testing anything.
        expect(clientReadable.length).toBeGreaterThan(0);

        for (const thing of clientReadable) {
            const executable = harness.registry.clientExecutable(thing);
            expect(executable, `${thing.key} did not resolve to an executable`).toBeTruthy();
            const outcome = await executable!.execute(ARGS[thing.key ?? ""] ?? {}, NO_CONTEXT);
            expect(outcome.kind, `${thing.key} did not answer with a value`).toBe("value");
        }
    });

    it("is non-mutating and unguarded, because the flag claims that too", () => {
        const harness = buildHarness([]);

        for (const thing of harness.catalogue.filter((operation) => operation.clientReadable)) {
            expect(thing.mutating ?? false, `${thing.key} is clientReadable AND mutating`).toBe(false);
            expect(
                thing.requiresApproval ?? false,
                `${thing.key} is clientReadable and requires an approval`,
            ).toBe(false);
        }
    });
});
