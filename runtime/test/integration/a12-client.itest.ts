/**
 * The raw JSON-RPC client, against the real Data Service.
 *
 * The unit tier drives an in-memory store, which by construction agrees with whatever the client
 * sends. Everything the store could disagree about — that Keycloak's direct access grant yields a
 * token the store accepts, the `Bearer` scheme, the batch-shaped body, whether a markdown string
 * survives a round trip — is only observable here.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { A12RpcError, type A12Client } from "../../src/a12/client.js";
import { eq } from "../../src/a12/things.js";
import { describeRpc, newClient, newJanitor, THING_STORE_UP, Trash, unique } from "./support/live.js";

const MARKDOWN = [
    "## Consultation",
    "",
    "- 2026-08-01: first visit",
    "- 2026-08-08: follow-up",
    "",
    "Billing runs through `Payables`.",
].join("\n");

describe.skipIf(!THING_STORE_UP)("A12 client against the live ThingStore", () => {
    let client: A12Client;
    let janitor: A12Client;
    const trash = new Trash();

    beforeAll(async () => {
        client = newClient();
        // Login is the probe: it fails loudly here rather than inside the first assertion.
        await client.login();
        janitor = newJanitor();
        await janitor.login();
    });

    afterAll(async () => {
        expect(await trash.empty()).toEqual([]);
    });

    it("logs in and gets a usable token", async () => {
        const fresh = newClient();
        await expect(fresh.login()).resolves.toBeUndefined();
        // A token that works is one the store accepts on an RPC, not one that merely exists.
        const result = await fresh.query({
            targetDocumentModel: "Party_DM",
            paging: { pageNumber: 0, pageSize: 1 },
        });
        expect(result.fullSize).toBeGreaterThanOrEqual(0);
    });

    it("round-trips a Party through ADD, GET, MODIFY, QUERY and DELETE", async () => {
        const key = unique("client-roundtrip");

        const docRef = trash.add(
            await client.addDocument("Party_DM", {
                Party: {
                    Kind: "person",
                    Role: "doctor",
                    Name: "itest Dr Meyer",
                    Email: "itest@example.invalid",
                    City: "Frechen",
                    // `lineBreaksPermitted` on this field is what makes the newlines legal;
                    // without it the store rejects the write.
                    Notes: MARKDOWN,
                    IdempotencyKey: key,
                    CreatedAt: "2020-01-01T00:00:00",
                },
            }),
        );
        expect(docRef).toMatch(/^Party_DM\//);

        const loaded = await client.getDocument(docRef);
        const party = loaded.document["Party"] as Record<string, unknown>;
        expect(party["Name"]).toBe("itest Dr Meyer");
        expect(party["Kind"]).toBe("person");
        expect(party["Email"]).toBe("itest@example.invalid");
        expect(party["IdempotencyKey"]).toBe(key);
        // The whole point of the markdown field: the newlines come back byte-identical.
        expect(party["Notes"]).toBe(MARKDOWN);
        expect(String(party["Notes"]).split("\n")).toHaveLength(6);

        await client.modifyDocument(docRef, {
            Party: {
                ...party,
                Name: "itest Dr Meyer-Schmidt",
                Notes: `${MARKDOWN}\n\n> amended`,
            },
        });

        const modified = await client.getDocument(docRef);
        const after = modified.document["Party"] as Record<string, unknown>;
        expect(after["Name"]).toBe("itest Dr Meyer-Schmidt");
        expect(after["Notes"]).toContain("> amended");
        expect(after["Notes"]).toContain("## Consultation");
        // The fields we did not touch are still there.
        expect(after["City"]).toBe("Frechen");
        expect(after["IdempotencyKey"]).toBe(key);

        const found = await client.query({
            targetDocumentModel: "Party_DM",
            constraint: eq("/Party/IdempotencyKey", key),
        });
        expect(found.fullSize).toBe(1);
        expect(found.entries[0]!.docRef).toBe(docRef);
        const queried = found.entries[0]!.document["Party"] as Record<string, unknown>;
        expect(queried["Name"]).toBe("itest Dr Meyer-Schmidt");

        // The Runtime identity may write but not delete (roles.yaml), so the delete leg runs as
        // the janitor — and the refusal is asserted below rather than worked around silently.
        await janitor.deleteDocument(docRef);
        trash.forget(docRef);

        const gone = await client.query({
            targetDocumentModel: "Party_DM",
            constraint: eq("/Party/IdempotencyKey", key),
        });
        expect(gone.fullSize).toBe(0);
        await expect(client.getDocument(docRef)).rejects.toThrow();
    });

    it("refuses to let the Runtime identity delete a Thing (roles.yaml withholds DOCUMENT_DELETE)", async () => {
        const docRef = trash.add(
            await client.addDocument("Party_DM", {
                Party: {
                    Name: "itest Undeletable By Runtime",
                    IdempotencyKey: unique("delete-denied"),
                    CreatedAt: "2020-01-01T00:00:00",
                },
            }),
        );

        const denied = await client.deleteDocument(docRef).then(
            () => undefined,
            (error: unknown) => error as A12RpcError,
        );
        expect(denied).toBeInstanceOf(A12RpcError);
        expect(describeRpc(denied!)).toMatch(/Access Denied/i);

        // Still there — the refusal is a refusal, not a partial delete.
        await expect(client.getDocument(docRef)).resolves.toBeTruthy();
    });

    it("surfaces a store-side failure as an A12RpcError rather than a silent success", async () => {
        await expect(client.getDocument("Party_DM/does-not-exist")).rejects.toBeInstanceOf(
            A12RpcError,
        );
    });

    it("sends a batch as an array and matches responses back by id", async () => {
        const [parties, invoices] = await client.rpc([
            {
                id: "parties",
                method: "QUERY",
                params: {
                    query: {
                        targetDocumentModel: "Party_DM",
                        projectionName: "document",
                        paging: { pageNumber: 0, pageSize: 1 },
                    },
                },
            },
            {
                id: "invoices",
                method: "QUERY",
                params: {
                    query: {
                        targetDocumentModel: "Invoice_DM",
                        projectionName: "document",
                        paging: { pageNumber: 0, pageSize: 1 },
                    },
                },
            },
        ]);
        expect((parties as { fullSize: number }).fullSize).toBeGreaterThanOrEqual(0);
        expect((invoices as { fullSize: number }).fullSize).toBeGreaterThanOrEqual(0);
    });
});
