import { afterEach, describe, expect, it } from "vitest";

import { eq, path, SPECS } from "../../src/a12/things.js";
import { startInbox, type Inbox } from "../../src/inbound/server.js";
import { buildHarness, type Harness } from "../support/harness.js";

/**
 * The inbox, behind real HTTP.
 *
 * `gate.test.ts` proves the decision; this proves the door honours it — over a real socket, with a
 * real body, because the failure worth catching is a transport that reaches `execute()` around the
 * check rather than a check that returns the wrong answer.
 *
 * The case that matters most is the one asserting `FakeFirefly` recorded **no posting**. A refusal
 * that answers "refused" and books the transaction anyway would pass a test that only read the status
 * code, and it is precisely the failure this whole design exists to prevent.
 */

const SECRET = "a-shared-secret-for-the-tests";
const ALLOWED = ["bookkeeping.listAccounts", "bookkeeping.listTransactions"];

let inbox: Inbox | undefined;

afterEach(async () => {
    await inbox?.close();
    inbox = undefined;
});

async function open(harness: Harness, allowlist: readonly string[] = ALLOWED): Promise<string> {
    // Port 0: the operating system picks a free one, so the suite never collides with itself or with
    // whatever else is listening on this machine.
    inbox = await startInbox({ port: 0, secret: SECRET, allowlist, registry: harness.registry });
    return `http://127.0.0.1:${inbox.port}`;
}

/** `null` means "send no secret header at all" — `undefined` would take the default below. */
async function call(
    base: string,
    operation: string,
    args: Record<string, unknown> = {},
    secret: string | null = SECRET,
): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${base}/operations/${encodeURIComponent(operation)}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(secret === null ? {} : { "X-Runtime-Secret": secret }),
        },
        body: JSON.stringify({ args }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("the Runtime's inbox", () => {
    it("executes an allowed Operation and hands back its outcome", async () => {
        const harness = buildHarness([]);
        const base = await open(harness);

        const { status, body } = await call(base, "bookkeeping.listAccounts");

        expect(status).toBe(200);
        expect(body["ok"]).toBe(true);
        const outcome = body["outcome"] as { kind: string; value: Array<Record<string, unknown>> };
        expect(outcome.kind).toBe("value");
        expect(outcome.value.map((account) => account["name"])).toContain("Checking");
        // The field this change added, asserted where it is actually consumed.
        expect(outcome.value[0]?.["currency"]).toBe("EUR");
    });

    it("passes an Operation's arguments through", async () => {
        const harness = buildHarness([]);
        const base = await open(harness);

        const { body } = await call(base, "bookkeeping.listTransactions", {
            start: "2026-01-01",
            end: "2026-12-31",
            limit: 10,
        });

        const outcome = body["outcome"] as { kind: string; value: Array<Record<string, unknown>> };
        expect(outcome.kind).toBe("value");
        // Three rows from two groups: the flattening the demo household cannot demonstrate.
        expect(outcome.value).toHaveLength(3);
        expect(outcome.value[0]?.["description"]).toBe("Consultation and dressing change, 24 July");
    });

    it("REFUSES a mutating Operation, and books nothing", async () => {
        const harness = buildHarness([]);
        const base = await open(harness, [...ALLOWED, "bookkeeping.postTransaction"]);

        const { status, body } = await call(base, "bookkeeping.postTransaction", {
            splits: [
                {
                    type: "withdrawal",
                    date: "2026-08-01",
                    amount: "100.00",
                    description: "not on my watch",
                    sourceAccount: "Checking",
                    destinationAccount: "Expenses:Health",
                },
            ],
        });

        expect(status).toBe(403);
        expect(body["ok"]).toBe(false);
        // The assertion the status code cannot make.
        expect(harness.firefly.posted).toHaveLength(0);
    });

    it("refuses a wrong secret", async () => {
        const harness = buildHarness([]);
        const base = await open(harness);

        const { status, body } = await call(base, "bookkeeping.listAccounts", {}, "not-the-secret");

        expect(status).toBe(401);
        expect(body["ok"]).toBe(false);
    });

    it("refuses a missing secret", async () => {
        const harness = buildHarness([]);
        const base = await open(harness);

        const { status } = await call(base, "bookkeeping.listAccounts", {}, null);

        expect(status).toBe(401);
    });

    it("refuses an Operation that is not on the allowlist", async () => {
        const harness = buildHarness([]);
        const base = await open(harness, ["bookkeeping.listAccounts"]);

        const { status } = await call(base, "bookkeeping.getBalance", { account: "Checking" });

        expect(status).toBe(403);
    });

    it("refuses a malformed body without falling over", async () => {
        const harness = buildHarness([]);
        const base = await open(harness);

        const response = await fetch(`${base}/operations/bookkeeping.listAccounts`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Runtime-Secret": SECRET },
            body: "{ this is not json",
        });

        expect(response.status).toBe(400);
        // Still serving afterwards: one bad request must not take the door down.
        expect((await call(base, "bookkeeping.listAccounts")).status).toBe(200);
    });

    it("hands a failing Operation back as a failure, without dressing it as a refusal", async () => {
        const harness = buildHarness([]);
        // An allowed Operation whose *world* is broken — Firefly is down — as opposed to a call the
        // gate declined. The tile renders the same error line either way, but conflating the two here
        // would mean a refused call and an unreachable Firefly were indistinguishable in the log.
        harness.firefly.listAccounts = () => Promise.reject(new Error("firefly is unreachable"));
        const base = await open(harness);

        const { status, body } = await call(base, "bookkeeping.listAccounts");

        expect(status).toBe(502);
        expect(body["ok"]).toBe(false);
        expect(String(body["reason"])).not.toBe("not-allowed");
    });

    it("answers a health probe without a secret, and executes nothing", async () => {
        const harness = buildHarness([]);
        const base = await open(harness);

        const response = await fetch(`${base}/healthz`);

        expect(response.status).toBe(200);
    });

    it("refuses an Operation the User has switched off", async () => {
        // The one check in the gate that reads a Thing, because `Enabled` is genuinely the User's
        // decision (ADR-0019). Switched off means off everywhere — not merely hidden from Assistants.
        const harness = buildHarness([]);
        const stored = (await harness.things.search<{ key?: string; enabled?: boolean }>(
            SPECS.Operation_DM,
            eq(path(SPECS.Operation_DM, "key"), "bookkeeping.listAccounts"),
            2,
        ))[0]!;
        await harness.things.update(SPECS.Operation_DM, stored.docRef, { enabled: false });

        inbox = await startInbox({
            port: 0,
            secret: SECRET,
            allowlist: ALLOWED,
            registry: harness.registry,
            things: harness.things,
        });

        const { status, body } = await call(
            `http://127.0.0.1:${inbox.port}`,
            "bookkeeping.listAccounts",
        );

        expect(status).toBe(403);
        expect(body["reason"]).toBe("not-allowed");
    });

    it("still admits an Operation that is switched on", async () => {
        const harness = buildHarness([]);
        inbox = await startInbox({
            port: 0,
            secret: SECRET,
            allowlist: ALLOWED,
            registry: harness.registry,
            things: harness.things,
        });

        const { status } = await call(`http://127.0.0.1:${inbox.port}`, "bookkeeping.listAccounts");

        expect(status).toBe(200);
    });

    it("refuses an unknown path", async () => {
        const harness = buildHarness([]);
        const base = await open(harness);

        const response = await fetch(`${base}/operations`, {
            method: "POST",
            headers: { "X-Runtime-Secret": SECRET },
            body: "{}",
        });

        expect(response.status).toBe(404);
    });
});
