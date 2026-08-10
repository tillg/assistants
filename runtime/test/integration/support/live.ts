/**
 * Shared wiring for the integration tier.
 *
 * Everything in `test/integration` talks to the stack `just dev` brings up. Two rules follow
 * from that and are enforced here rather than remembered per test:
 *
 *   1. **Absent stack ⇒ skipped, never failed.** The probes below run at module load so the
 *      suites can `describe.skipIf(...)` at collection time; `npm run test:integration` on a
 *      laptop with nothing running is all-skipped, not red.
 *   2. **Nothing we write may be mistaken for demo data.** Every Thing we create carries an
 *      `itest:` idempotency key, and `Trash` deletes it again — except for the two Models the
 *      Runtime owns, which we are not allowed to delete at all.
 */

import { execFileSync } from "node:child_process";
import { A12Client } from "../../../src/a12/client.js";
import { FireflyConnector } from "../../../src/connectors/firefly.js";
import { ThingRepository } from "../../../src/a12/things.js";

export const THING_STORE_URL = process.env["ITEST_THINGSTORE_URL"] ?? "http://localhost:8082";
export const THING_STORE_USER = process.env["ITEST_THINGSTORE_USER"] ?? "runtime";
export const THING_STORE_PASSWORD =
    process.env["ITEST_THINGSTORE_PASSWORD"] ?? "assistants-runtime-dev";

/**
 * The identity provider, as seen from the host: `localhost:8089`, not the `keycloak:8080` the
 * containers use. The `iss` claim is the same either way -- KC_HOSTNAME pins it -- so a token
 * minted here is one the ThingStore accepts.
 */
export const KEYCLOAK_URL = process.env["ITEST_KEYCLOAK_URL"] ?? "http://localhost:8089";
export const KEYCLOAK_REALM = process.env["ITEST_KEYCLOAK_REALM"] ?? "A12Realm";
export const KEYCLOAK_CLIENT_ID = process.env["ITEST_KEYCLOAK_CLIENT_ID"] ?? "assistants-runtime-client";

/**
 * The janitor: a second identity, for everything the Runtime may not do.
 *
 * `import/auth/roles.yaml` grants the `runtime` role DOCUMENT_CREATE and DOCUMENT_UPDATE but
 * deliberately not DOCUMENT_DELETE — "the Assistant Runtime writes Things but must never delete
 * one" — and, since D-007a, not ASSISTANT_WRITE either. So the tier can neither clean up nor write
 * an Assistant as the Runtime: it creates as `runtime` (which is what the Runtime does), and
 * deletes and writes Assistants as a `user`-role account (which is what the User can do).
 */
export const JANITOR_USER = process.env["ITEST_JANITOR_USER"] ?? "user1";
export const JANITOR_PASSWORD = process.env["ITEST_JANITOR_PASSWORD"] ?? "A12PT-user1test";
export const FIREFLY_URL = process.env["ITEST_FIREFLY_URL"] ?? "http://localhost:8084";
export const FIREFLY_UI_URL = process.env["ITEST_UI_URL"] ?? "http://localhost:8081";

/** The marker that keeps our Things out of the demo data, and greppable when one leaks. */
export const ITEST = "itest:";

/**
 * `createdAt` for anything trigger-eligible.
 *
 * The Runtime is *also* running against this store, and its materialised scan births a
 * Conversation for every new Document. A `createdAt` far below the watermark is invisible to
 * that scan (`createdAt < watermark` is skipped explicitly), so our fixtures cannot wake the
 * live Runtime up.
 */
export const LONG_AGO = "2020-01-01T00:00:00";

async function reachable(url: string): Promise<boolean> {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
        return response.ok;
    } catch {
        return false;
    }
}

/** The PAT the bootstrap container drops into a shared volume. */
function readFireflyToken(): string {
    const fromEnv = process.env["ITEST_FIREFLY_TOKEN"] ?? process.env["FIREFLY_TOKEN"] ?? "";
    if (fromEnv) return fromEnv;
    try {
        return execFileSync(
            "docker",
            ["run", "--rm", "-v", "assistants_firefly_token:/t", "alpine", "cat", "/t/pat.txt"],
            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ).trim();
    } catch {
        return "";
    }
}

export const FIREFLY_TOKEN = readFireflyToken();

// Probed once, at module load, so `describe.skipIf` can see the answer.
export const THING_STORE_UP = await reachable(`${THING_STORE_URL}/actuator/health`);
export const FIREFLY_UP = FIREFLY_TOKEN !== "" && (await reachable(`${FIREFLY_URL}/healthcheck`));

export function newClient(): A12Client {
    return new A12Client({
        baseUrl: THING_STORE_URL,
        username: THING_STORE_USER,
        password: THING_STORE_PASSWORD,
        keycloakUrl: KEYCLOAK_URL,
        keycloakRealm: KEYCLOAK_REALM,
        keycloakClientId: KEYCLOAK_CLIENT_ID,
        locale: "en",
    });
}

/**
 * A client with DOCUMENT_DELETE, for cleanup and for the delete leg of the round trip.
 *
 * Also the identity for anything only the **User** may write. Since D-007a that is `Assistant_DM`:
 * the `runtime` role has no `ASSISTANT_WRITE`, so the tier round-trips an Assistant as the User —
 * and asserts the Runtime's refusal on its own rather than quietly designing around it.
 */
export function newJanitor(): A12Client {
    return new A12Client({
        baseUrl: THING_STORE_URL,
        username: JANITOR_USER,
        password: JANITOR_PASSWORD,
        keycloakUrl: KEYCLOAK_URL,
        keycloakRealm: KEYCLOAK_REALM,
        keycloakClientId: KEYCLOAK_CLIENT_ID,
        locale: "en",
    });
}

export function newThings(client: A12Client): ThingRepository {
    return new ThingRepository(client);
}

export function newFirefly(): FireflyConnector {
    return new FireflyConnector(FIREFLY_URL, FIREFLY_TOKEN, undefined, FIREFLY_UI_URL);
}

/** A unique suffix, so a re-run never collides with a fixture a previous run failed to delete. */
export function unique(label: string): string {
    return `${ITEST}${label}:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The Models the Runtime owns. A Conversation may be mid-flight and an OpenQuestion may be the
 * only record of a question the User is answering right now, so the integration tier never
 * deletes either — it reuses one inert fixture per Model under a fixed key instead.
 */
export const UNDELETABLE = new Set(["Conversation_DM", "OpenQuestion_DM"]);

export class Trash {
    private readonly docRefs = new Set<string>();

    add(docRef: string): string {
        if (!UNDELETABLE.has(docRef.slice(0, docRef.indexOf("/")))) this.docRefs.add(docRef);
        return docRef;
    }

    forget(docRef: string): void {
        this.docRefs.delete(docRef);
    }

    /** Deletes as the janitor, because the `runtime` role may not delete at all. */
    async empty(): Promise<string[]> {
        const failures: string[] = [];
        if (this.docRefs.size === 0) return failures;
        const janitor = newJanitor();
        for (const docRef of this.docRefs) {
            try {
                await janitor.deleteDocument(docRef);
            } catch (error) {
                failures.push(`${docRef}: ${String(error)}`);
            }
        }
        this.docRefs.clear();
        return failures;
    }
}

/**
 * The readable half of an A12 failure.
 *
 * `A12RpcError.message` is always the same sentence ("JSON-RPC Request failed and rollback was
 * performed"); what actually went wrong sits in `data.description.default`. Assertions have to
 * dig for it, which is worth knowing when reading a Runtime log too.
 */
export function describeRpc(error: unknown): string {
    const data = (error as { rpcError?: { data?: { description?: { default?: string } } } })
        ?.rpcError?.data;
    return `${(error as Error)?.message ?? String(error)} ${data?.description?.default ?? ""}`;
}

/** Same reason as `deleteTransaction`: the Connector has no delete, and a test that creates an
 * account has to remove it or the chart grows a little on every run. */
export async function deleteAccount(id: string): Promise<void> {
    await fetch(`${FIREFLY_URL.replace(/\/+$/, "")}/api/v1/accounts/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${FIREFLY_TOKEN}`, Accept: "application/json" },
    }).catch(() => undefined);
}

/** Firefly has no delete in the Connector — cleaning up a posted transaction is raw REST. */
export async function deleteTransaction(id: string): Promise<void> {
    await fetch(`${FIREFLY_URL.replace(/\/+$/, "")}/api/v1/transactions/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${FIREFLY_TOKEN}`, Accept: "application/json" },
    }).catch(() => undefined);
}
