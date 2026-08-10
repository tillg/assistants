/**
 * Every query the Watcher issues, executed by the real Data Service.
 *
 * This is the suite that earns the tier. A constraint is a JSON object: the in-memory store
 * happily matches whatever shape it is handed, so a malformed constraint is indistinguishable
 * from a well-formed one until a server parses it. Three separate bugs lived exactly here —
 * `not` taking a singular `operand`, the projection needing an explicit locale, and enumeration
 * fields being indexed by display text — and all three presented as "the scan quietly does
 * nothing", never as a failing unit test.
 *
 * The bar deliberately is *not* "these rows come back". Getting zero rows is a legitimate state
 * of the store. The bar is "the server parsed and executed it", i.e. it did not error.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { A12Client, type Constraint } from "../../src/a12/client.js";
import {
    SPECS,
    ThingRepository,
    and,
    eq,
    nowIso,
    not,
    or,
    path as fieldPath,
    setButNot,
    unset,
} from "../../src/a12/things.js";
import type { ModelSpec } from "../../src/a12/things.js";
import { TRIGGER_ELIGIBLE_MODELS } from "../../src/domain/types.js";
import { RUNTIME_STATE_KEY } from "../../src/watcher/watcher.js";
import {
    describeRpc,
    KEYCLOAK_CLIENT_ID,
    KEYCLOAK_REALM,
    KEYCLOAK_URL,
    LONG_AGO,
    newClient,
    newThings,
    THING_STORE_URL,
    THING_STORE_USER,
    THING_STORE_PASSWORD,
    THING_STORE_UP,
    Trash,
    unique,
} from "./support/live.js";

const C = SPECS.Conversation_DM;

/** Every shape the six scans and their helpers send, named after the scan that sends it. */
const SCAN_QUERIES: Array<{ name: string; spec: ModelSpec; constraint?: Constraint }> = [
    { name: "scan 1 · enabled assistants (unconstrained)", spec: SPECS.Assistant_DM },
    ...TRIGGER_ELIGIBLE_MODELS.map((model) => {
        const spec = (SPECS as Record<string, ModelSpec>)[model]!;
        return {
            name: `scan 1 · materialised ${model} since the watermark (date_range)`,
            spec,
            constraint: {
                operator: "date_range",
                field: fieldPath(spec, "createdAt"),
                from: nowIso(new Date(Date.now() - 3_600_000)),
                to: nowIso(new Date(Date.now() + 60_000)),
            } as Constraint,
        };
    }),
    {
        name: "scan 2 · waiting on the User with a question outstanding",
        spec: C,
        constraint: and(
            eq(fieldPath(C, "status"), "waiting"),
            eq(fieldPath(C, "waitingFor"), "user"),
            not(unset(fieldPath(C, "currentQuestionId"))),
        ),
    },
    {
        name: "scan 3 · waiting with a wakeAt",
        spec: C,
        constraint: and(
            eq(fieldPath(C, "status"), "waiting"),
            not(unset(fieldPath(C, "wakeAt"))),
        ),
    },
    {
        name: "scan 4 · running with a lease",
        spec: C,
        constraint: and(
            eq(fieldPath(C, "status"), "running"),
            not(unset(fieldPath(C, "leaseUntil"))),
        ),
    },
    {
        name: "scan 5 · finished child whose result was never delivered",
        spec: C,
        constraint: and(
            eq(fieldPath(C, "status"), "done"),
            setButNot(fieldPath(C, "parentConversationId"), fieldPath(C, "resultDeliveredAt")),
        ),
    },
    {
        name: "scan 6 · running without a lease",
        spec: C,
        constraint: and(
            eq(fieldPath(C, "status"), "running"),
            unset(fieldPath(C, "leaseUntil")),
        ),
    },
    {
        name: "helper · a conversation already exists for (assistant, subject)",
        spec: C,
        constraint: and(
            eq(fieldPath(C, "assistantKey"), "receptionist"),
            eq(fieldPath(C, "subjectThingId"), "00000000-0000-0000-0000-000000000000"),
        ),
    },
    {
        name: "helper · the runtime state singleton",
        spec: SPECS.RuntimeState_DM,
        constraint: eq(fieldPath(SPECS.RuntimeState_DM, "singletonKey"), RUNTIME_STATE_KEY),
    },
    {
        name: "helper · a Thing by idempotency key",
        spec: SPECS.Party_DM,
        constraint: eq(fieldPath(SPECS.Party_DM, "idempotencyKey"), "itest:never-written"),
    },
];

/** The builders in `things.ts`, each driven on its own so a failure names the builder. */
const BUILDERS: Array<{ name: string; spec: ModelSpec; constraint: Constraint }> = [
    { name: "eq (string)", spec: SPECS.Party_DM, constraint: eq(fieldPath(SPECS.Party_DM, "kind"), "person") },
    { name: "eq (number)", spec: C, constraint: eq(fieldPath(C, "turnCount"), 1) },
    { name: "eq (boolean)", spec: SPECS.Assistant_DM, constraint: eq(fieldPath(SPECS.Assistant_DM, "enabled"), true) },
    { name: "unset", spec: C, constraint: unset(fieldPath(C, "leaseUntil")) },
    { name: "not", spec: C, constraint: not(unset(fieldPath(C, "wakeAt"))) },
    {
        name: "and",
        spec: C,
        constraint: and(eq(fieldPath(C, "status"), "done"), eq(fieldPath(C, "waitingFor"), "user")),
    },
    {
        name: "or",
        spec: C,
        constraint: or(eq(fieldPath(C, "status"), "done"), eq(fieldPath(C, "status"), "running")),
    },
    {
        name: "setButNot",
        spec: C,
        constraint: setButNot(fieldPath(C, "parentConversationId"), fieldPath(C, "resultDeliveredAt")),
    },
    {
        name: "nested and(or(...), not(...))",
        spec: C,
        constraint: and(
            or(eq(fieldPath(C, "status"), "done"), eq(fieldPath(C, "status"), "failed")),
            not(eq(fieldPath(C, "assistantKey"), "itest-assistant")),
        ),
    },
];

describe.skipIf(!THING_STORE_UP)("watcher queries against the live ThingStore", () => {
    let client: A12Client;
    let things: ThingRepository;
    const trash = new Trash();

    beforeAll(async () => {
        client = newClient();
        await client.login();
        things = newThings(client);
    });

    afterAll(async () => {
        expect(await trash.empty()).toEqual([]);
    });

    describe("the constraint builders parse", () => {
        for (const { name, spec, constraint } of BUILDERS) {
            it(`${name} is accepted by the server`, async () => {
                const result = await client.query({
                    targetDocumentModel: spec.model,
                    constraint,
                    paging: { pageNumber: 0, pageSize: 5 },
                });
                // Zero rows is fine. An error is not.
                expect(Array.isArray(result.entries)).toBe(true);
                expect(result.fullSize).toBeGreaterThanOrEqual(0);
            });
        }
    });

    describe("every scan the Watcher runs parses", () => {
        for (const { name, spec, constraint } of SCAN_QUERIES) {
            it(`${name}`, async () => {
                const result = await client.query({
                    targetDocumentModel: spec.model,
                    ...(constraint ? { constraint } : {}),
                    paging: { pageNumber: 0, pageSize: 50 },
                });
                expect(Array.isArray(result.entries)).toBe(true);
                expect(result.fullSize).toBeGreaterThanOrEqual(0);
            });
        }
    });

    it("pages, at the 100-row ceiling the store enforces", async () => {
        const page = await client.query({
            targetDocumentModel: SPECS.Party_DM.model,
            paging: { pageNumber: 0, pageSize: 100 },
        });
        expect(page.entries.length).toBeLessThanOrEqual(100);
        // `ThingRepository.search` defaults to exactly 100; one more is rejected outright, so
        // that default is the ceiling and not merely a convention.
        await expect(
            client.query({
                targetDocumentModel: SPECS.Party_DM.model,
                paging: { pageNumber: 0, pageSize: 101 },
            }),
        ).rejects.toSatisfy((error: unknown) => /allowed limit 100/i.test(describeRpc(error)));
    });

    it(
        "QuerySpec.sort uses the server's field names: `direction`, not `order`",
        async () => {
            // The obvious names are wrong, and all four parts are required: the Data Service rejects
            // `order`/`nulls`, and rejects a null `nullHandling` or `ignoreCase` too. Nothing in
            // `src/` sorts today, which is exactly why this needs a test.
            await client.query({
                targetDocumentModel: SPECS.Party_DM.model,
                paging: { pageNumber: 0, pageSize: 2 },
                sort: [
                    {
                        field: fieldPath(SPECS.Party_DM, "createdAt"),
                        direction: "DESC",
                        nullHandling: "NULLS_LAST",
                        ignoreCase: false,
                    },
                ],
            });
        },
    );

    it.fails(
        "known defect · exact_match with an empty string value is rejected by the server",
        async () => {
            // `conversation.waitingFor` is cleared to `""`, so a scan that filtered on
            // `eq(waitingFor, "")` would fail rather than match. No scan does today.
            await client.query({
                targetDocumentModel: C.model,
                constraint: eq(fieldPath(C, "waitingFor"), ""),
            });
        },
    );

    it("actually matches rows, not merely parses — a seeded Party is found by every builder shape", async () => {
        const key = unique("watcher-match");
        const created = await things.create(SPECS.Party_DM, {
            kind: "organisation",
            role: "insurer",
            name: "itest Watcher Match",
            createdAt: LONG_AGO,
            idempotencyKey: key,
        });
        trash.add(created.docRef);

        const P = SPECS.Party_DM;
        const byKey = eq(fieldPath(P, "idempotencyKey"), key);

        const combinations: Array<[string, Constraint]> = [
            ["eq", byKey],
            ["and", and(byKey, eq(fieldPath(P, "kind"), "organisation"))],
            ["or", or(byKey, eq(fieldPath(P, "idempotencyKey"), "itest:never-written"))],
            ["not(unset)", and(byKey, not(unset(fieldPath(P, "role"))))],
            ["unset", and(byKey, unset(fieldPath(P, "createdByConversationId")))],
            ["setButNot", and(byKey, setButNot(fieldPath(P, "role"), fieldPath(P, "createdByConversationId")))],
        ];

        for (const [label, constraint] of combinations) {
            const found = await things.search(P, constraint, 5);
            expect(found.map((row) => row.docRef), `${label} did not match the seeded Party`).toContain(
                created.docRef,
            );
        }
    });

    describe("the assertion has teeth", () => {
        it("rejects `not` with the plural `operands` — the bug this suite exists for", async () => {
            await expect(
                client.query({
                    targetDocumentModel: C.model,
                    // `and`/`or` take `operands`; `not` takes `operand`. Getting it wrong is a
                    // server-side rejection, invisible to any in-memory store.
                    constraint: { operator: "not", operands: [unset(fieldPath(C, "wakeAt"))] },
                }),
            ).rejects.toSatisfy((error: unknown) =>
                /Please provide operand for not operator/i.test(describeRpc(error)),
            );
        });

        it("rejects a query whose Accept-Language is not a real locale", async () => {
            // Node's fetch defaults to `Accept-Language: *`, which the Data Service takes as the
            // projection locale and rejects. Pinning the header in A12Client is the whole fix;
            // this proves the failure it prevents is real.
            const wildcard = new A12Client({
                baseUrl: THING_STORE_URL,
                username: THING_STORE_USER,
                password: THING_STORE_PASSWORD,
                keycloakUrl: KEYCLOAK_URL,
                keycloakRealm: KEYCLOAK_REALM,
                keycloakClientId: KEYCLOAK_CLIENT_ID,
                locale: "en",
                fetchImpl: (input, init) => {
                    const headers = new Headers(init?.headers);
                    if (String(input).endsWith("/api/v2/rpc")) headers.set("Accept-Language", "*");
                    return fetch(input, { ...init, headers });
                },
            });
            await expect(
                wildcard.query({ targetDocumentModel: SPECS.Party_DM.model }),
            ).rejects.toSatisfy((error: unknown) =>
                /unsupported locale: \*/i.test(describeRpc(error)),
            );
        });
    });
});
