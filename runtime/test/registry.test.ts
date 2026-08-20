/**
 * Resolution: an Assistant's grants, joined against the catalogue and the registered Implementations.
 *
 * The join is the whole of this change (ADR-0019), and every branch of it is a decision someone can
 * make from the web application: switch an Operation off, tick "requires approval", or grant a key
 * that no longer names anything. So the fixture here is a hand-built catalogue rather than the
 * bootstrapped one — the point is what the registry does with the data, not what bootstrap puts in it.
 */

import { describe, expect, it, vi } from "vitest";
import {
    OperationRegistry,
    type OperationContext,
    type OperationImplementation,
    type OperationOutcome,
} from "../src/operations/registry.js";
import { OperationHost } from "../src/operations/dynamic/host.js";
import type { DynamicOperationConfig } from "../src/config.js";
import type { Assistant, Operation } from "../src/domain/types.js";

function implementation(
    name: string,
    overrides: {
        mutating?: boolean;
        seed?: Partial<OperationImplementation["seed"]>;
    } = {},
): OperationImplementation {
    return {
        name,
        mutating: overrides.mutating ?? false,
        async execute(): Promise<OperationOutcome> {
            return { kind: "value", value: name };
        },
        seed: {
            name,
            system: "Runtime",
            kind: "internal",
            description: `The seeded description of ${name}.`,
            parameters: { type: "object", properties: { seeded: { type: "string" } } },
            ...overrides.seed,
        },
    };
}

/** One Operation Thing, as the catalogue read would hand it over. */
function operation(key: string, overrides: Partial<Operation> = {}): Operation {
    return {
        key,
        name: key,
        system: "Runtime",
        kind: "internal",
        description: `The stored description of ${key}.`,
        parameters: '{"type":"object","properties":{"stored":{"type":"string"}}}',
        mutating: false,
        enabled: true,
        ...overrides,
    };
}

function assistant(grants: string[], key = "receptionist"): Assistant {
    return { key, name: key, grants: grants.map((operationKey) => ({ operationKey })) };
}

function registryWith(...implementations: OperationImplementation[]): OperationRegistry {
    const registry = new OperationRegistry();
    registry.registerAll(implementations);
    return registry;
}

/** What reached the log, as one string per line. */
function warnings(): { lines: () => string[]; restore: () => void } {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    return {
        lines: () => spy.mock.calls.map((call) => call.map(String).join(" ")),
        restore: () => spy.mockRestore(),
    };
}

describe("a grant the catalogue cannot honour", () => {
    it("drops a grant naming an Operation that is not in the catalogue, and says whose it was", () => {
        const registry = registryWith(implementation("email.send"));
        const log = warnings();

        const { granted, dropped } = registry.grantedTo(assistant(["email.send"]), []);

        expect(granted).toEqual([]);
        expect(dropped).toEqual([{ key: "email.send", reason: "absent" }]);
        expect(log.lines().join("\n")).toContain("email.send");
        expect(log.lines().join("\n")).toContain("receptionist");
        log.restore();
    });

    it("drops an Operation the User has switched off", () => {
        const registry = registryWith(implementation("email.send"));
        const log = warnings();

        const { granted, dropped } = registry.grantedTo(assistant(["email.send"]), [
            operation("email.send", { enabled: false }),
        ]);

        expect(granted).toEqual([]);
        expect(dropped).toEqual([{ key: "email.send", reason: "disabled" }]);
        log.restore();
    });

    it("treats an unset Enabled as enabled, because a hand-created Operation must not be silently off", () => {
        const registry = registryWith(implementation("email.send"));

        const { granted, dropped } = registry.grantedTo(assistant(["email.send"]), [
            operation("email.send", { enabled: undefined }),
        ]);

        expect(dropped).toEqual([]);
        expect(granted.map((one) => one.name)).toEqual(["email.send"]);
    });

    it("drops an Operation no Implementation is registered under", () => {
        const registry = registryWith(implementation("email.send"));
        const log = warnings();

        const { granted, dropped } = registry.grantedTo(assistant(["email.fetch"]), [
            operation("email.fetch"),
        ]);

        expect(granted).toEqual([]);
        expect(dropped).toEqual([{ key: "email.fetch", reason: "unimplemented" }]);
        log.restore();
    });

    it("drops an Operation whose Parameters are not JSON, and logs what the parser said", () => {
        const registry = registryWith(implementation("email.send"));
        const log = warnings();

        const { granted, dropped } = registry.grantedTo(assistant(["email.send"]), [
            operation("email.send", { parameters: "{ not json at all" }),
        ]);

        expect(granted).toEqual([]);
        expect(dropped).toEqual([{ key: "email.send", reason: "unparseable" }]);
        // The parse error, not merely "it failed": this field is read-only in the form, so a
        // failure here means a hand-edited document or a bad seed, and the reader needs the reason.
        expect(log.lines().join("\n")).toMatch(/JSON|token|position/i);
        log.restore();
    });

    it.each(["null", "5", "true", '"x"'])(
        "drops an Operation whose Parameters are the valid JSON %s, which is not a schema",
        (parameters) => {
            // Parsing was the whole guard, and all four of these parse. `null` was the one that
            // killed a Conversation outright: `withCalleeBound` read `properties` off it, the
            // TypeError left `advance()`, and nothing above it escalates — so the Conversation was
            // retried every two seconds forever with the heartbeat green. The other three reached
            // the provider as a `tools` entry whose parameters are a number, a boolean or a string.
            const registry = registryWith(implementation("assistant.call", { mutating: true }));
            const log = warnings();

            const { granted, dropped } = registry.grantedTo(assistant(["assistant.call:accountant"]), [
                operation("assistant.call", { parameters }),
            ]);

            expect(granted).toEqual([]);
            expect(dropped).toEqual([{ key: "assistant.call:accountant", reason: "unparseable" }]);
            // The reader is told what it got, not merely that it was wrong.
            expect(log.lines().join("\n")).toMatch(/JSON object/);
            log.restore();
        },
    );
});

describe("what the resolved Operation is made of", () => {
    it("takes the description and the parameters from the Thing, not from the seed", () => {
        const registry = registryWith(implementation("email.send"));

        const { granted } = registry.grantedTo(assistant(["email.send"]), [
            operation("email.send", {
                description: "What the User wrote.",
                parameters: '{"type":"object","properties":{"edited":{"type":"string"}}}',
            }),
        ]);

        expect(granted[0]!.description).toBe("What the User wrote.");
        expect(granted[0]!.parameters).toEqual({
            type: "object",
            properties: { edited: { type: "string" } },
        });
    });

    it("requires an approval when the Thing asks for one and the seed did not", () => {
        const registry = registryWith(implementation("email.send"));

        const { granted } = registry.grantedTo(assistant(["email.send"]), [
            operation("email.send", { requiresApproval: true }),
        ]);

        expect(granted[0]!.requiresApproval).toBe(true);
    });

    it("permits a Thing that asks for less than the seed, and warns once per Operation, not once per resolution", () => {
        const registry = registryWith(
            implementation("bookkeeping.postTransaction", { seed: { requiresApproval: true } }),
        );
        const catalogue = [operation("bookkeeping.postTransaction", { requiresApproval: false })];
        const who = assistant(["bookkeeping.postTransaction"]);
        const log = warnings();

        const first = registry.grantedTo(who, catalogue);
        const second = registry.grantedTo(who, catalogue);

        // The User is sovereign over their own money: the Thing wins in both directions.
        expect(first.granted[0]!.requiresApproval).toBeFalsy();
        expect(second.granted[0]!.requiresApproval).toBeFalsy();

        // Once per process. The snapshot is read once per Turn, so warning per resolution is how a
        // warning becomes a line people filter out.
        const weakened = log
            .lines()
            .filter((line) => line.includes("bookkeeping.postTransaction") && /approval/i.test(line));
        expect(weakened).toHaveLength(1);
        log.restore();
    });

    it("reads mutating from the Implementation even when the Thing says the opposite", () => {
        const registry = registryWith(implementation("bookkeeping.postTransaction", { mutating: true }));

        const { granted } = registry.grantedTo(assistant(["bookkeeping.postTransaction"]), [
            operation("bookkeeping.postTransaction", { mutating: false }),
        ]);

        // `reconcile()` treats a non-mutating Operation as safe to consider repeated, so a Thing
        // that could set this would let crash recovery report a booking as harmless.
        expect(granted[0]!.mutating).toBe(true);
    });
});

describe("the three properties that were each a bug once", () => {
    const call = implementation("assistant.call", { mutating: true });
    const catalogue = [operation("assistant.call")];

    it("does not treat a bare assistant.call as a wildcard", () => {
        const registry = registryWith(call);
        const log = warnings();

        const { granted, dropped } = registry.grantedTo(assistant(["assistant.call"]), catalogue);

        expect(granted).toEqual([]);
        expect(dropped).toEqual([{ key: "assistant.call", reason: "bare-call" }]);
        log.restore();
    });

    it("refuses a self-call", () => {
        const registry = registryWith(call);
        const log = warnings();

        const { granted, dropped } = registry.grantedTo(
            assistant(["assistant.call:receptionist", "assistant.call:accountant"]),
            catalogue,
        );

        expect(granted.map((one) => one.name)).toEqual(["assistant.call:accountant"]);
        expect(dropped).toEqual([{ key: "assistant.call:receptionist", reason: "self-call" }]);
        log.restore();
    });

    it("collapses a duplicated grant", () => {
        const registry = registryWith(implementation("email.send"));

        const { granted, dropped } = registry.grantedTo(
            assistant(["email.send", "email.send"]),
            [operation("email.send")],
        );

        expect(granted.map((one) => one.name)).toEqual(["email.send"]);
        expect(dropped).toEqual([]);
    });

    it("collapses a duplicated assistant.call too, per callee", () => {
        // The dedup check sat in the branch the callee-bound grants never take, so two grants
        // naming one callee produced two functions of the same name in the provider's `tools`
        // array — which OpenAI rejects outright, failing the whole Turn rather than the grant.
        const registry = registryWith(call);
        const log = warnings();

        const { granted, dropped } = registry.grantedTo(
            assistant(["assistant.call:accountant", "assistant.call:accountant", "assistant.call:auditor"]),
            catalogue,
        );

        expect(granted.map((one) => one.name)).toEqual([
            "assistant.call:accountant",
            "assistant.call:auditor",
        ]);
        expect(dropped).toEqual([]);
        log.restore();
    });

    it("leaves calleesOf alone: it is string work over the grants and needs no catalogue", () => {
        const registry = registryWith(call);

        expect(
            registry.calleesOf(
                assistant(["assistant.call:receptionist", "assistant.call:accountant", "email.send"]),
            ),
        ).toEqual(["accountant"]);
    });
});

describe("schemasFor", () => {
    it("offers the Thing's description under the wire name, and nothing that was dropped", () => {
        const registry = registryWith(implementation("email.send"), implementation("email.fetch"));
        const log = warnings();

        const schemas = registry.schemasFor(assistant(["email.send", "email.fetch"]), [
            operation("email.send", { description: "Send an email." }),
            operation("email.fetch", { enabled: false }),
        ]);

        expect(schemas).toEqual([
            {
                name: "email__send",
                description: "Send an email.",
                parameters: { type: "object", properties: { stored: { type: "string" } } },
            },
        ]);
        log.restore();
    });
});

/**
 * The two-source join (ADR-0025). A grant may now resolve against stored Source as well as compiled
 * code, and the registry is where the new branches — dynamic, uncompilable, ambiguous, an
 * unconfigured egress — are enforced. Every one of these is a decision (or a mistake) someone made
 * from the web application, so the fixture is a hand-built catalogue, as above.
 */
function hostConfig(overrides: Partial<DynamicOperationConfig> = {}): DynamicOperationConfig {
    return {
        timeoutMs: 20_000,
        maxBodyBytes: 4 * 1024 * 1024,
        memoryMb: 128,
        cacheTtlMs: 300_000,
        egresses: { bookkeeping: { url: "http://127.0.0.1:9/", token: "t" } },
        ...overrides,
    };
}

function dynamicRegistry(host: OperationHost, ...implementations: OperationImplementation[]): OperationRegistry {
    const registry = new OperationRegistry(host);
    registry.registerAll(implementations);
    return registry;
}

const ctx = { idempotencyKey: "conv:1" } as unknown as OperationContext;

/** A dynamic Operation Thing: Source, an egress, and `implementation: "dynamic"`. */
function dynamic(key: string, source: string, overrides: Partial<Operation> = {}): Operation {
    return operation(key, {
        system: "Bookkeeping",
        kind: "connector",
        implementation: "dynamic",
        source,
        egress: "bookkeeping",
        ...overrides,
    });
}

describe("a Dynamic Operation resolves against its stored Source", () => {
    it("resolves and executes source through the Operation Host", async () => {
        const registry = dynamicRegistry(new OperationHost(hostConfig()));
        const { granted, dropped } = registry.grantedTo(assistant(["bookkeeping.getBalance"]), [
            dynamic("bookkeeping.getBalance", "function execute(args) { return args.x + 1; }"),
        ]);

        expect(dropped).toEqual([]);
        expect(granted).toHaveLength(1);
        expect(await granted[0]!.execute({ x: 41 }, ctx)).toEqual({ kind: "value", value: 42 });
    });

    it("reads mutating from the Thing for a dynamic Operation", () => {
        const registry = dynamicRegistry(new OperationHost(hostConfig()));
        const { granted } = registry.grantedTo(assistant(["bookkeeping.postTransaction"]), [
            dynamic("bookkeeping.postTransaction", "function execute() { return 1; }\nfunction reconcile() {}", {
                mutating: true,
            }),
        ]);
        expect(granted[0]!.mutating).toBe(true);
    });

    it("gives a money-moving dynamic Operation its synchronous approval describer", () => {
        const registry = dynamicRegistry(new OperationHost(hostConfig()));
        const { granted } = registry.grantedTo(assistant(["bookkeeping.postTransaction"]), [
            dynamic("bookkeeping.postTransaction", "function execute() { return 1; }\nfunction reconcile() {}", {
                mutating: true,
                requiresApproval: true,
            }),
        ]);
        // The describer renders the money sentence the approval prompt shows, so the User reads
        // "€184.30 from *Payables* …" rather than a raw JSON args block (ADR-0025 follow-up).
        const prompt = granted[0]!.describeCall?.({
            splits: [{ amount: "184.30", sourceAccount: "Payables", destinationAccount: "Expenses:Health" }],
        });
        expect(prompt).toBe("Book €184.30 from *Payables* to *Expenses:Health*?");
    });

    it("leaves an ordinary dynamic Operation without a describer", () => {
        const registry = dynamicRegistry(new OperationHost(hostConfig()));
        const { granted } = registry.grantedTo(assistant(["bookkeeping.getBalance"]), [
            dynamic("bookkeeping.getBalance", "function execute() { return 1; }"),
        ]);
        expect(granted[0]!.describeCall).toBeUndefined();
    });

    it("reads mutating from code for a built-in, ignoring the Thing's copy", () => {
        const registry = dynamicRegistry(
            new OperationHost(hostConfig()),
            implementation("email.send", { mutating: true }),
        );
        const { granted } = registry.grantedTo(assistant(["email.send"]), [
            operation("email.send", { mutating: false }),
        ]);
        // The Thing says false; code says true; code wins, because `reconcile` trusts it (ADR-0025).
        expect(granted[0]!.mutating).toBe(true);
    });

    it("treats unset implementation as built-in", () => {
        const registry = dynamicRegistry(new OperationHost(hostConfig()), implementation("email.send"));
        const { granted, dropped } = registry.grantedTo(assistant(["email.send"]), [
            operation("email.send", { implementation: undefined }),
        ]);
        expect(dropped).toEqual([]);
        expect(granted).toHaveLength(1);
    });
});

describe("a Dynamic Operation the catalogue cannot honour", () => {
    it("drops implementation:dynamic with no source as unimplemented", () => {
        const registry = dynamicRegistry(new OperationHost(hostConfig()));
        const { granted, dropped } = registry.grantedTo(assistant(["bookkeeping.getBalance"]), [
            operation("bookkeeping.getBalance", { implementation: "dynamic", source: "" }),
        ]);
        expect(granted).toEqual([]);
        expect(dropped).toEqual([{ key: "bookkeeping.getBalance", reason: "unimplemented" }]);
    });

    it("drops source that does not compile as uncompilable, with the reason in the log", () => {
        const registry = dynamicRegistry(new OperationHost(hostConfig()));
        const log = warnings();
        const { granted, dropped } = registry.grantedTo(assistant(["bookkeeping.getBalance"]), [
            dynamic("bookkeeping.getBalance", "function execute( { return 1; }"),
        ]);
        expect(granted).toEqual([]);
        expect(dropped).toEqual([{ key: "bookkeeping.getBalance", reason: "uncompilable" }]);
        expect(log.lines().join("\n")).toContain("bookkeeping.getBalance");
        log.restore();
    });

    it("drops a dynamic Thing that is also registered in code as ambiguous", () => {
        const registry = dynamicRegistry(
            new OperationHost(hostConfig()),
            implementation("bookkeeping.getBalance"),
        );
        const { granted, dropped } = registry.grantedTo(assistant(["bookkeeping.getBalance"]), [
            dynamic("bookkeeping.getBalance", "function execute() { return 1; }"),
        ]);
        expect(granted).toEqual([]);
        expect(dropped).toEqual([{ key: "bookkeeping.getBalance", reason: "ambiguous" }]);
    });

    it("drops a built-in Thing that carries stored source as ambiguous — the other direction", () => {
        const registry = dynamicRegistry(new OperationHost(hostConfig()), implementation("email.send"));
        const { granted, dropped } = registry.grantedTo(assistant(["email.send"]), [
            operation("email.send", { implementation: "built-in", source: "function execute() {}" }),
        ]);
        expect(granted).toEqual([]);
        expect(dropped).toEqual([{ key: "email.send", reason: "ambiguous" }]);
    });

    it("drops a dynamic Thing naming an undefined egress, with the egress in the log", () => {
        const registry = dynamicRegistry(new OperationHost(hostConfig()));
        const log = warnings();
        const { granted, dropped } = registry.grantedTo(assistant(["bookkeeping.getBalance"]), [
            dynamic("bookkeeping.getBalance", "function execute() { return 1; }", { egress: "nowhere" }),
        ]);
        expect(granted).toEqual([]);
        expect(dropped).toEqual([{ key: "bookkeeping.getBalance", reason: "unconfigured-egress" }]);
        expect(log.lines().join("\n")).toContain("nowhere");
        log.restore();
    });

    it("resolves a mutating dynamic Operation with no reconcile, but reports it", () => {
        const registry = dynamicRegistry(new OperationHost(hostConfig()));
        const log = warnings();
        const { granted, dropped } = registry.grantedTo(assistant(["bookkeeping.postTransaction"]), [
            dynamic("bookkeeping.postTransaction", "function execute() { return 1; }", { mutating: true }),
        ]);
        expect(dropped).toEqual([]);
        expect(granted).toHaveLength(1);
        expect(log.lines().join("\n")).toContain("declares no reconcile");
        log.restore();
    });
});
