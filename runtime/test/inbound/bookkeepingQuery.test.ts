import { describe, expect, it } from "vitest";

import { FireflyConnector } from "../../src/connectors/firefly.js";

/**
 * What the Connector puts into an outbound Firefly transactions query — the date range and the
 * account, encoded so nothing a browser hands it can steer the request. (The `listTransactions`
 * Operation itself, and its date refusal and limit clamp, are a Dynamic Operation now and are tested
 * in `operations/dynamicBookkeeping.test.ts`; this keeps the Connector's own encoding under test.)
 */

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
