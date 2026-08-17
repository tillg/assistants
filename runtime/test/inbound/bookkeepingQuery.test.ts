import { describe, expect, it } from "vitest";

import { FireflyConnector } from "../../src/connectors/firefly.js";
import { buildHarness } from "../support/harness.js";
import type { OperationContext } from "../../src/operations/registry.js";

/**
 * What a browser is allowed to put into an outbound Firefly query.
 *
 * `bookkeeping.listTransactions` is `clientReadable` (ADR-0023), so its arguments now arrive from any
 * authenticated browser user rather than only from an Assistant's own reasoning. That changes what
 * "a date" means: it stops being a value the Runtime composed and becomes a value the Runtime was
 * handed. Two things follow, and both are tested here — the Connector must encode whatever it is
 * given, and the Operation must refuse what is not a date at all.
 */

const NO_CONTEXT = undefined as unknown as OperationContext;

/** Firefly's own answers, reduced to what these two calls actually read. */
function fakeFirefly(): { urls: string[]; fetchImpl: typeof fetch } {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
        const url = String(input);
        urls.push(url);
        const body = url.includes("/accounts?")
            ? { data: [{ id: "77", attributes: { name: "Checking", type: "asset" } }] }
            : { data: [] };
        return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    }) as unknown as typeof fetch;
    return { urls, fetchImpl };
}

describe("the Firefly transactions query", () => {
    it("encodes a date rather than letting it smuggle a second parameter", async () => {
        const { urls, fetchImpl } = fakeFirefly();
        const firefly = new FireflyConnector("http://firefly", "token", undefined, "http://ui", fetchImpl);

        await firefly.listTransactions({ start: "2026-01-01", end: "2030-01-01&page=2", limit: 5 });

        const url = urls.at(-1)!;
        // The whole point: `&page=` may appear only as a parameter this code chose to send.
        expect(url).not.toContain("&page=2");
        expect(url).toContain("end=2030-01-01%26page%3D2");
        expect(url).toContain("limit=5");
    });

    it("encodes the account id on the per-account shape too", async () => {
        const { urls, fetchImpl } = fakeFirefly();
        const firefly = new FireflyConnector("http://firefly", "token", undefined, "http://ui", fetchImpl);

        await firefly.listTransactions({
            start: "2026-01-01",
            end: "2026-01-31",
            accountName: "Checking",
            limit: 25,
        });

        const url = urls.at(-1)!;
        expect(url).toContain("/accounts/77/transactions?");
        expect(url).toContain("start=2026-01-01");
        expect(url).toContain("end=2026-01-31");
    });
});

async function listTransactions(args: Record<string, unknown>) {
    const harness = buildHarness([]);
    const seen: Array<{ start: string; end: string; limit?: number }> = [];
    harness.firefly.listTransactions = async (input) => {
        seen.push(input);
        return [];
    };
    const outcome = await harness.registry
        .get("bookkeeping.listTransactions")!
        .execute(args, NO_CONTEXT);
    return { outcome, seen };
}

describe("bookkeeping.listTransactions", () => {
    it("refuses a start that is not a date, with a message a model can act on", async () => {
        const { outcome, seen } = await listTransactions({ start: "yesterday", end: "2026-01-31" });

        expect(outcome.kind).toBe("error");
        expect(String((outcome as { message: string }).message)).toContain("yyyy-mm-dd");
        expect(seen).toHaveLength(0);
    });

    it("refuses an end carrying a smuggled parameter", async () => {
        const { outcome, seen } = await listTransactions({
            start: "2026-01-01",
            end: "2030-01-01&page=2",
        });

        expect(outcome.kind).toBe("error");
        expect(seen).toHaveLength(0);
    });

    it("caps the limit, because the caller is now a browser", async () => {
        const { seen } = await listTransactions({
            start: "2026-01-01",
            end: "2026-01-31",
            limit: 1_000_000,
        });

        expect(seen[0]?.limit).toBe(200);
    });

    it("floors the limit at one rather than asking Firefly for zero or fewer", async () => {
        expect(
            (await listTransactions({ start: "2026-01-01", end: "2026-01-31", limit: 0 })).seen[0]
                ?.limit,
        ).toBe(25);
        expect(
            (await listTransactions({ start: "2026-01-01", end: "2026-01-31", limit: -5 })).seen[0]
                ?.limit,
        ).toBe(1);
    });
});
