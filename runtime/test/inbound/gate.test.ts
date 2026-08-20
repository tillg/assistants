import { describe, expect, it } from "vitest";

import { decide } from "../../src/inbound/gate.js";
import { OperationRegistry, type OperationImplementation } from "../../src/operations/registry.js";
import { OperationHost } from "../../src/operations/dynamic/host.js";
import type { DynamicOperationConfig } from "../../src/config.js";
import type { Operation } from "../../src/domain/types.js";

/**
 * The gate, alone.
 *
 * This is the file that decides whether a browser can reach the books, and it is tested before any
 * HTTP exists so that the decision is never entangled with the transport. Every case below is either
 * "this must be allowed" or "this must be refused", and the refusals are the point: the route exists
 * to be narrow.
 *
 * The one property the whole change rests on — **opening a read route does not open a write one** —
 * is the `postTransaction` case, asserted twice: once as an ordinary refusal, and once with the
 * Operation deliberately put on the allowlist, because a gate that can be defeated by a
 * configuration mistake is not a gate.
 */

const ALLOWED = ["bookkeeping.listAccounts", "bookkeeping.listTransactions"];

function implementation(overrides: Partial<OperationImplementation>): OperationImplementation {
    return {
        name: "test.operation",
        mutating: false,
        clientReadable: true,
        async execute() {
            return { kind: "value", value: null };
        },
        seed: {
            name: "Test",
            system: "Bookkeeping",
            kind: "connector",
            description: "for the gate's tests",
            parameters: { type: "object", properties: {} },
        },
        ...overrides,
    };
}

function registryOf(...implementations: OperationImplementation[]): OperationRegistry {
    const registry = new OperationRegistry();
    registry.registerAll(implementations);
    return registry;
}

describe("the External Call gate", () => {
    it("admits an allowlisted, client-readable, non-mutating Operation", () => {
        const listAccounts = implementation({ name: "bookkeeping.listAccounts" });
        const verdict = decide("bookkeeping.listAccounts", registryOf(listAccounts), ALLOWED);

        expect(verdict.allowed).toBe(true);
        expect(verdict.allowed && verdict.implementation).toBe(listAccounts);
    });

    it("refuses a mutating Operation", () => {
        const post = implementation({
            name: "bookkeeping.postTransaction",
            mutating: true,
            clientReadable: undefined,
        });

        expect(decide("bookkeeping.postTransaction", registryOf(post), ALLOWED).allowed).toBe(false);
    });

    it("refuses a mutating Operation even when the allowlist names it", () => {
        // The configuration mistake this gate has to survive. `mutating` is code and the allowlist is
        // config; the conjunction is what stops the weaker of the two from deciding.
        const post = implementation({
            name: "bookkeeping.postTransaction",
            mutating: true,
            clientReadable: true,
        });
        const generous = [...ALLOWED, "bookkeeping.postTransaction"];

        expect(decide("bookkeeping.postTransaction", registryOf(post), generous).allowed).toBe(false);
    });

    it("refuses a client-readable Operation that is not on the allowlist", () => {
        const balance = implementation({ name: "bookkeeping.getBalance" });

        expect(decide("bookkeeping.getBalance", registryOf(balance), ALLOWED).allowed).toBe(false);
    });

    it("refuses an allowlisted Operation whose implementation does not claim to be client-readable", () => {
        const listAccounts = implementation({
            name: "bookkeeping.listAccounts",
            clientReadable: undefined,
        });

        expect(decide("bookkeeping.listAccounts", registryOf(listAccounts), ALLOWED).allowed).toBe(false);
    });

    it("refuses an Operation whose code shipped wanting an approval", () => {
        // `requiresApproval` is not on the Implementation — only on its seed — and the inbox does not
        // resolve against the catalogue, so the seed is the only place it can see this. Refusing on it
        // costs nothing and closes the gap.
        const guarded = implementation({
            name: "bookkeeping.listAccounts",
            seed: { ...implementation({}).seed, requiresApproval: true },
        });

        expect(decide("bookkeeping.listAccounts", registryOf(guarded), ALLOWED).allowed).toBe(false);
    });

    it("refuses a name nothing implements", () => {
        expect(decide("bookkeeping.listAccounts", registryOf(), ALLOWED).allowed).toBe(false);
    });

    it("refuses everything when the allowlist is empty", () => {
        const listAccounts = implementation({ name: "bookkeeping.listAccounts" });

        expect(decide("bookkeeping.listAccounts", registryOf(listAccounts), []).allowed).toBe(false);
    });

    it("tells every refusal the same way, so probing the route reveals nothing about the catalogue", () => {
        const post = implementation({ name: "bookkeeping.postTransaction", mutating: true });
        const reasons = [
            decide("bookkeeping.postTransaction", registryOf(post), ALLOWED),
            decide("bookkeeping.getBalance", registryOf(), ALLOWED),
            decide("nothing.at.all", registryOf(), ALLOWED),
        ].map((verdict) => (verdict.allowed ? "allowed" : verdict.reason));

        expect(new Set(reasons).size).toBe(1);
        expect(reasons[0]).toBe("not-allowed");
    });
});

/**
 * The same gate, for a Dynamic Operation (ADR-0025). Three of the four flags now come from the
 * Operation Thing rather than from code, and the allowlist — the one control not in the store — is
 * what carries the weight. This is why the Dashboard's two now-dynamic reads keep working, and why a
 * mis-edited `mutating` or `clientReadable` on a Thing still cannot open a write route.
 */
function hostedRegistry(): OperationRegistry {
    const config: DynamicOperationConfig = {
        timeoutMs: 20_000,
        maxBodyBytes: 4 * 1024 * 1024,
        memoryMb: 128,
        cacheTtlMs: 300_000,
        egresses: { bookkeeping: { url: "http://127.0.0.1:9/", token: "t" } },
    };
    return new OperationRegistry(new OperationHost(config));
}

function dynamicThing(overrides: Partial<Operation> = {}): Operation {
    return {
        key: "bookkeeping.listAccounts",
        name: "bookkeeping.listAccounts",
        system: "Bookkeeping",
        kind: "connector",
        implementation: "dynamic",
        source: "function execute() { return { kind: 'value', value: [] }; }",
        egress: "bookkeeping",
        parameters: '{"type":"object","properties":{}}',
        clientReadable: true,
        mutating: false,
        enabled: true,
        ...overrides,
    };
}

describe("the gate for a Dynamic Operation", () => {
    it("admits an allowlisted, client-readable, non-mutating, unguarded dynamic Operation", () => {
        const verdict = decide("bookkeeping.listAccounts", hostedRegistry(), ALLOWED, dynamicThing());
        expect(verdict.allowed).toBe(true);
        expect(verdict.allowed && typeof verdict.execute).toBe("function");
    });

    it("refuses the same dynamic Operation when it is off the allowlist", () => {
        expect(decide("bookkeeping.listAccounts", hostedRegistry(), [], dynamicThing()).allowed).toBe(false);
    });

    it("refuses a dynamic Operation the Thing marks mutating", () => {
        const verdict = decide(
            "bookkeeping.listAccounts",
            hostedRegistry(),
            ALLOWED,
            dynamicThing({ mutating: true }),
        );
        expect(verdict.allowed).toBe(false);
    });

    it("refuses a dynamic Operation whose clientReadable is unset", () => {
        const verdict = decide(
            "bookkeeping.listAccounts",
            hostedRegistry(),
            ALLOWED,
            dynamicThing({ clientReadable: undefined }),
        );
        expect(verdict.allowed).toBe(false);
    });

    it("refuses a dynamic Operation the Thing marks as requiring an approval", () => {
        const verdict = decide(
            "bookkeeping.listAccounts",
            hostedRegistry(),
            ALLOWED,
            dynamicThing({ requiresApproval: true }),
        );
        expect(verdict.allowed).toBe(false);
    });

    it("refuses when the Thing could not be read, rather than trusting a dynamic call blind", () => {
        // No `thing` passed: a Dynamic Operation reads its flags from it, so absence must fail closed.
        expect(decide("bookkeeping.listAccounts", hostedRegistry(), ALLOWED, undefined).allowed).toBe(false);
    });
});
