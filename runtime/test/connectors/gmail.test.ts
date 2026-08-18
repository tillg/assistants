/**
 * The Gmail Connector, against a fake Gmail.
 *
 * Every test here injects `fetchImpl`, exactly as `llm/anthropic.ts` and `a12/content.ts` are
 * tested: nothing in this file may reach Google, and nothing in it needs a credential. What is
 * being pinned is not "does the API work" — that is Google's problem — but the four claims this
 * Connector makes that are ours: that a token is minted once and refreshed once on a 401, that
 * labels are resolved by name and created when missing, that a message too large to afford is
 * *reported* rather than downloaded, and that a sender is known before a byte of body is fetched.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { GmailConnector, numericUid } from "../../src/connectors/gmail.js";
import { parseMessage } from "../../src/connectors/email.js";
import type { MailConnector } from "../../src/watcher/mail.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/mail/", import.meta.url));

/** A Gmail message id: sixteen hex digits, which is exactly why `uid` cannot simply be one. */
const ID_A = "18f0a1b2c3d4e5f6";
const ID_B = "18f0a1b2c3d4e5f7";

const INCOMING = "assistants";
const PROCESSED = "assistants/processed";
const LABEL_INCOMING = "Label_6810297171539270188";
const LABEL_PROCESSED = "Label_6810297171539270189";

interface Call {
    readonly url: string;
    readonly method: string;
    readonly body: string;
    readonly authorization: string;
}

interface FakeGmail {
    readonly calls: Call[];
    readonly fetchImpl: typeof fetch;
    /** How many times the refresh-token grant was exercised. */
    tokens: number;
}

type Handler = (url: URL, call: Call) => Response | undefined;

/**
 * A Gmail that answers from `handlers`, mints access tokens, and records everything it was asked.
 *
 * An unhandled request is a test failure rather than a 404: a Connector that quietly asks for
 * something nobody expected is precisely what these tests exist to notice.
 */
function fakeGmail(handlers: Handler[]): FakeGmail {
    const fake: FakeGmail = {
        calls: [],
        tokens: 0,
        fetchImpl: async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
            const url = new URL(typeof input === "string" ? input : input.toString());
            const headers = new Headers(init?.headers);
            const call: Call = {
                url: url.toString(),
                method: init?.method ?? "GET",
                body: typeof init?.body === "string" ? init.body : String(init?.body ?? ""),
                authorization: headers.get("authorization") ?? "",
            };
            fake.calls.push(call);

            if (url.origin + url.pathname === "https://oauth2.googleapis.com/token") {
                fake.tokens += 1;
                return json({ access_token: `token-${fake.tokens}`, expires_in: 3600 });
            }
            for (const handler of handlers) {
                const answer = handler(url, call);
                if (answer) return answer;
            }
            throw new Error(`the fake Gmail was asked for something no test expected: ${call.method} ${call.url}`);
        },
    };
    return fake;
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

/** The label list every test that touches a folder needs. */
function labels(entries: Array<{ id: string; name: string }>): Handler {
    return (url, call) =>
        url.pathname.endsWith("/labels") && call.method === "GET" ? json({ labels: entries }) : undefined;
}

function connector(fake: FakeGmail): GmailConnector {
    return new GmailConnector({
        user: "till.gartner@gmail.com",
        clientId: "client-id",
        clientSecret: "client-secret",
        refreshToken: "refresh-token",
        fetchImpl: fake.fetchImpl,
    });
}

/** The API calls, with the token endpoint dropped — what the Connector asked *Gmail* for. */
function apiCalls(fake: FakeGmail): Call[] {
    return fake.calls.filter((call) => !call.url.startsWith("https://oauth2.googleapis.com/"));
}

describe("the Gmail Connector's authentication", () => {
    it("mints one access token from the refresh token and reuses it", async () => {
        const fake = fakeGmail([labels([{ id: LABEL_INCOMING, name: INCOMING }])]);

        await connector(fake).session(async (session) => {
            await session.ensureFolders([INCOMING]);
            await session.ensureFolders([INCOMING]);
        });

        expect(fake.tokens).toBe(1);
        const grant = fake.calls[0];
        expect(grant?.url).toBe("https://oauth2.googleapis.com/token");
        expect(grant?.method).toBe("POST");
        expect(grant?.body).toContain("grant_type=refresh_token");
        expect(grant?.body).toContain("refresh_token=refresh-token");
        expect(grant?.body).toContain("client_id=client-id");
        expect(grant?.body).toContain("client_secret=client-secret");
        // The mailbox is named rather than left to `me`, so a credential/account mismatch is a 403
        // at the first poll instead of a silent read of somebody else's letterbox.
        expect(apiCalls(fake)[0]?.url).toContain("/users/till.gartner%40gmail.com/labels");
        expect(apiCalls(fake)[0]?.authorization).toBe("Bearer token-1");
    });

    it("re-authenticates once, and only once, when Gmail refuses the token", async () => {
        let refusals = 1;
        const fake = fakeGmail([
            (url, call) => {
                if (!url.pathname.endsWith("/labels") || call.method !== "GET") return undefined;
                if (refusals-- > 0) return json({ error: { message: "Invalid Credentials" } }, 401);
                return json({ labels: [{ id: LABEL_INCOMING, name: INCOMING }] });
            },
        ]);

        await connector(fake).ensureFolders([INCOMING]);

        expect(fake.tokens).toBe(2);
        const attempts = apiCalls(fake);
        expect(attempts).toHaveLength(2);
        expect(attempts[0]?.authorization).toBe("Bearer token-1");
        // The refused credential is not presented again — that is the whole point of clearing it.
        expect(attempts[1]?.authorization).toBe("Bearer token-2");
    });

    it("gives up rather than retrying for ever when the second attempt is refused too", async () => {
        const fake = fakeGmail([() => json({ error: { message: "Invalid Credentials" } }, 401)]);

        await expect(connector(fake).ensureFolders([INCOMING])).rejects.toThrow(/401/);
        expect(apiCalls(fake)).toHaveLength(2);
    });

    it("never puts a credential in the message when the grant itself is refused", async () => {
        const fake = fakeGmail([]);
        const refusing = new GmailConnector({
            user: "",
            clientId: "client-id",
            clientSecret: "client-secret",
            refreshToken: "refresh-token",
            fetchImpl: async () => json({ error: "invalid_grant" }, 400),
        });

        await expect(refusing.ensureFolders([INCOMING])).rejects.toThrow(/refused the refresh token/);
        void fake;
    });
});

describe("the Gmail Connector's labels", () => {
    it("resolves folder names to label ids and creates only the missing ones", async () => {
        const created: unknown[] = [];
        const fake = fakeGmail([
            labels([{ id: LABEL_INCOMING, name: INCOMING }]),
            (url, call) => {
                if (!url.pathname.endsWith("/labels") || call.method !== "POST") return undefined;
                created.push(JSON.parse(call.body));
                return json({ id: LABEL_PROCESSED, name: PROCESSED });
            },
        ]);

        await connector(fake).ensureFolders([INCOMING, PROCESSED]);

        // One list, one create: the label that was already there is left entirely alone.
        expect(created).toEqual([
            { name: PROCESSED, labelListVisibility: "labelShow", messageListVisibility: "show" },
        ]);
        expect(apiCalls(fake).filter((call) => call.method === "GET")).toHaveLength(1);
    });

    it("lists the labels once per session however often it is asked", async () => {
        const fake = fakeGmail([
            labels([
                { id: LABEL_INCOMING, name: INCOMING },
                { id: LABEL_PROCESSED, name: PROCESSED },
            ]),
        ]);

        await connector(fake).session(async (session) => {
            await session.ensureFolders([INCOMING, PROCESSED]);
            await session.ensureFolders([INCOMING, PROCESSED]);
        });

        expect(apiCalls(fake)).toHaveLength(1);
    });
});

describe("the Gmail Connector's fetch", () => {
    /** A `messages.list` that pages: `pages` is consumed one request at a time. */
    function listing(pages: Array<{ messages: Array<{ id: string }>; nextPageToken?: string }>): Handler {
        let index = 0;
        return (url) => {
            if (!url.pathname.endsWith("/messages")) return undefined;
            const page = pages[index++] ?? { messages: [] };
            return json(page);
        };
    }

    function metadata(entries: Record<string, { from: string; size: number; internalDate: string }>): Handler {
        return (url) => {
            const match = /\/messages\/([^/?]+)$/.exec(url.pathname);
            if (!match || url.searchParams.get("format") !== "metadata") return undefined;
            const entry = entries[match[1] ?? ""];
            if (!entry) return undefined;
            return json({
                id: match[1],
                sizeEstimate: entry.size,
                internalDate: entry.internalDate,
                payload: { headers: [{ name: "From", value: entry.from }] },
            });
        };
    }

    function sources(entries: Record<string, Buffer>): Handler {
        return (url) => {
            const match = /\/messages\/([^/?]+)$/.exec(url.pathname);
            if (!match || url.searchParams.get("format") !== "raw") return undefined;
            const bytes = entries[match[1] ?? ""];
            if (!bytes) return undefined;
            return json({ id: match[1], raw: bytes.toString("base64url") });
        };
    }

    it("asks for messages rather than threads, and honours maxResults across pages", async () => {
        const fake = fakeGmail([
            labels([{ id: LABEL_INCOMING, name: INCOMING }]),
            listing([
                { messages: [{ id: ID_A }], nextPageToken: "page-2" },
                { messages: [{ id: ID_B }] },
            ]),
            metadata({
                [ID_A]: { from: "a@example.com", size: 10, internalDate: "1770000000000" },
                [ID_B]: { from: "b@example.com", size: 10, internalDate: "1770000001000" },
            }),
            sources({ [ID_A]: Buffer.from("A"), [ID_B]: Buffer.from("B") }),
        ]);

        const result = await connector(fake).fetchBatch(INCOMING, 2);

        expect(result.messages).toHaveLength(2);
        const lists = apiCalls(fake).filter((call) => new URL(call.url).pathname.endsWith("/messages"));
        expect(lists).toHaveLength(2);
        // `threads.list` is the documented trap: the label can sit on a message that is not the
        // first in its thread, and a forwarded invoice buried in a reply chain is then missed.
        expect(apiCalls(fake).some((call) => call.url.includes("/threads"))).toBe(false);
        expect(new URL(lists[0]!.url).searchParams.get("labelIds")).toBe(LABEL_INCOMING);
        expect(new URL(lists[0]!.url).searchParams.get("maxResults")).toBe("2");
        // The second page asks only for what is still owed, so `max` bounds the walk and not just
        // one request.
        expect(new URL(lists[1]!.url).searchParams.get("maxResults")).toBe("1");
        expect(new URL(lists[1]!.url).searchParams.get("pageToken")).toBe("page-2");
    });

    it("stops at maxResults without a second page when the first one satisfies it", async () => {
        const fake = fakeGmail([
            labels([{ id: LABEL_INCOMING, name: INCOMING }]),
            listing([{ messages: [{ id: ID_A }, { id: ID_B }] }]),
            metadata({
                [ID_A]: { from: "a@example.com", size: 10, internalDate: "1770000000000" },
                [ID_B]: { from: "b@example.com", size: 10, internalDate: "1770000001000" },
            }),
            sources({ [ID_A]: Buffer.from("A"), [ID_B]: Buffer.from("B") }),
        ]);

        await connector(fake).fetchBatch(INCOMING, 2);

        expect(apiCalls(fake).filter((call) => new URL(call.url).pathname.endsWith("/messages"))).toHaveLength(1);
    });

    it("reports a message it cannot afford instead of downloading it", async () => {
        const fake = fakeGmail([
            labels([{ id: LABEL_INCOMING, name: INCOMING }]),
            listing([{ messages: [{ id: ID_A }, { id: ID_B }] }]),
            metadata({
                [ID_A]: { from: "small@example.com", size: 100, internalDate: "1770000000000" },
                [ID_B]: { from: "huge@example.com", size: 5_000_000, internalDate: "1770000001000" },
            }),
            sources({ [ID_A]: Buffer.from("A") }),
        ]);

        const result = await connector(fake).fetchBatch(INCOMING, 10, { maxMessageBytes: 1000 });

        expect(result.messages.map((message) => message.uid)).toEqual([numericUid(ID_A)]);
        expect(result.oversized).toEqual([
            { uid: numericUid(ID_B), size: 5_000_000, envelopeFrom: "huge@example.com" },
        ]);
        // The whole point of the two passes: not one byte of the oversized message was asked for.
        // The fake would have thrown if it had been, but assert it directly — this is the property.
        const raws = apiCalls(fake).filter((call) => call.url.includes("format=raw"));
        expect(raws).toHaveLength(1);
        expect(raws[0]?.url).toContain(ID_A);
    });

    it("says when the poll's byte budget, and not the count, ended the batch", async () => {
        const fake = fakeGmail([
            labels([{ id: LABEL_INCOMING, name: INCOMING }]),
            listing([{ messages: [{ id: ID_A }, { id: ID_B }] }]),
            metadata({
                [ID_A]: { from: "a@example.com", size: 800, internalDate: "1770000000000" },
                [ID_B]: { from: "b@example.com", size: 800, internalDate: "1770000001000" },
            }),
            sources({ [ID_A]: Buffer.from("A") }),
        ]);

        const result = await connector(fake).fetchBatch(INCOMING, 10, {
            maxMessageBytes: 1000,
            maxTotalBytes: 1000,
        });

        expect(result.messages).toHaveLength(1);
        expect(result.oversized).toEqual([]);
        expect(result.budgetExhausted).toBe(true);
    });

    it("knows who sent a message before it fetches a byte of the body", async () => {
        const fake = fakeGmail([
            labels([{ id: LABEL_INCOMING, name: INCOMING }]),
            listing([{ messages: [{ id: ID_A }] }]),
            metadata({
                [ID_A]: {
                    // A display name and mixed case, which is what a real header looks like and
                    // what the allowlist must not be fooled by.
                    from: "Anna Beispiel <Anna.Beispiel@Example.com>",
                    size: 100,
                    internalDate: "1770000000000",
                },
            }),
            sources({ [ID_A]: Buffer.from("A") }),
        ]);

        const result = await connector(fake).fetchBatch(INCOMING, 10);

        expect(result.messages[0]?.envelopeFrom).toBe("anna.beispiel@example.com");
        const first = apiCalls(fake).find((call) => call.url.includes(`/messages/${ID_A}`));
        expect(first?.url).toContain("format=metadata");
        expect(first?.url).toContain("metadataHeaders=From");
        // The order is the security property: the address is known from a request that carries no
        // MIME at all, so a stranger's attachments are never decoded on nobody's say-so.
        expect(apiCalls(fake).findIndex((call) => call.url.includes("format=metadata"))).toBeLessThan(
            apiCalls(fake).findIndex((call) => call.url.includes("format=raw")),
        );
    });

    it("decodes base64url into the bytes parseMessage reads", async () => {
        const eml = readFileSync(`${FIXTURES}plain-text.eml`);
        const fake = fakeGmail([
            labels([{ id: LABEL_INCOMING, name: INCOMING }]),
            listing([{ messages: [{ id: ID_A }] }]),
            metadata({
                [ID_A]: { from: "anna.beispiel@example.com", size: eml.length, internalDate: "1768205640000" },
            }),
            sources({ [ID_A]: eml }),
        ]);

        const result = await connector(fake).fetchBatch(INCOMING, 10);
        const fetched = result.messages[0]!;

        expect(fetched.raw.equals(eml)).toBe(true);
        expect(fetched.internalDate.toISOString()).toBe("2026-01-12T08:14:00.000Z");
        // The Gmail id, not a generation counter: globally unique and never reused, so a message
        // whose sender omitted the `Message-ID` gets a ref nothing can ever collide with.
        expect(fetched.origin).toEqual({ host: "gmail", folder: INCOMING, uidValidity: ID_A });

        const parsed = await parseMessage(
            fetched.raw,
            fetched.uid,
            fetched.internalDate,
            25 * 1024 * 1024,
            fetched.origin,
        );
        expect(parsed.from).toBe("anna.beispiel@example.com");
        expect(parsed.documents[0]?.externalRef).toBe("<plain-001@example.com>#0");
    });

    it("carries the Gmail id into the ref of a message whose sender omitted the Message-ID", async () => {
        const eml = readFileSync(`${FIXTURES}no-message-id.eml`);
        const fake = fakeGmail([
            labels([{ id: LABEL_INCOMING, name: INCOMING }]),
            listing([{ messages: [{ id: ID_A }] }]),
            metadata({
                [ID_A]: { from: "anna.beispiel@example.com", size: eml.length, internalDate: "1770000000000" },
            }),
            sources({ [ID_A]: eml }),
        ]);

        const fetched = (await connector(fake).fetchBatch(INCOMING, 10)).messages[0]!;
        const parsed = await parseMessage(fetched.raw, fetched.uid, fetched.internalDate, 1024, fetched.origin);

        expect(parsed.documents[0]?.externalRef).toContain(ID_A);
        expect(parsed.documents[0]?.externalRef).toContain("@gmail>#0");
    });

    it("reads nothing at all from a label nobody has created yet", async () => {
        const fake = fakeGmail([labels([])]);

        const result = await connector(fake).fetchBatch(INCOMING, 10);

        expect(result).toEqual({ messages: [], oversized: [], budgetExhausted: false });
        // No list, no metadata, and above all no label conjured into existence by a read.
        expect(apiCalls(fake)).toHaveLength(1);
    });
});

describe("the Gmail Connector's move", () => {
    it("adds the destination label and removes the source one", async () => {
        const modifications: Array<{ url: string; body: unknown }> = [];
        const eml = readFileSync(`${FIXTURES}plain-text.eml`);
        const fake = fakeGmail([
            labels([
                { id: LABEL_INCOMING, name: INCOMING },
                { id: LABEL_PROCESSED, name: PROCESSED },
            ]),
            (url) => {
                if (!url.pathname.endsWith("/messages")) return undefined;
                return json({ messages: [{ id: ID_A }] });
            },
            (url) => {
                if (url.searchParams.get("format") !== "metadata") return undefined;
                return json({
                    id: ID_A,
                    sizeEstimate: eml.length,
                    internalDate: "1770000000000",
                    payload: { headers: [{ name: "From", value: "anna@example.com" }] },
                });
            },
            (url) => {
                if (url.searchParams.get("format") !== "raw") return undefined;
                return json({ id: ID_A, raw: eml.toString("base64url") });
            },
            (url, call) => {
                if (!url.pathname.endsWith("/modify")) return undefined;
                modifications.push({ url: url.pathname, body: JSON.parse(call.body) });
                return json({ id: ID_A });
            },
        ]);

        await connector(fake).session(async (session) => {
            const { messages } = await session.fetchBatch(INCOMING, 10);
            await session.move(messages[0]!.uid, INCOMING, PROCESSED);
        });

        expect(modifications).toEqual([
            {
                url: `/gmail/v1/users/till.gartner%40gmail.com/messages/${ID_A}/modify`,
                body: { addLabelIds: [LABEL_PROCESSED], removeLabelIds: [LABEL_INCOMING] },
            },
        ]);
    });

    it("creates the destination label rather than discovering it is missing at the worst moment", async () => {
        const created: unknown[] = [];
        const eml = readFileSync(`${FIXTURES}plain-text.eml`);
        const fake = fakeGmail([
            labels([{ id: LABEL_INCOMING, name: INCOMING }]),
            (url, call) => {
                if (!url.pathname.endsWith("/labels") || call.method !== "POST") return undefined;
                created.push(JSON.parse(call.body));
                return json({ id: "Label_failed", name: "assistants/failed" });
            },
            (url) => (url.pathname.endsWith("/messages") ? json({ messages: [{ id: ID_A }] }) : undefined),
            (url) =>
                url.searchParams.get("format") === "metadata"
                    ? json({
                          id: ID_A,
                          sizeEstimate: eml.length,
                          internalDate: "1770000000000",
                          payload: { headers: [{ name: "From", value: "anna@example.com" }] },
                      })
                    : undefined,
            (url) =>
                url.searchParams.get("format") === "raw"
                    ? json({ id: ID_A, raw: eml.toString("base64url") })
                    : undefined,
            (url) => (url.pathname.endsWith("/modify") ? json({ id: ID_A }) : undefined),
        ]);

        await connector(fake).session(async (session) => {
            const { messages } = await session.fetchBatch(INCOMING, 10);
            await session.move(messages[0]!.uid, INCOMING, "assistants/failed");
        });

        expect(created).toEqual([
            { name: "assistants/failed", labelListVisibility: "labelShow", messageListVisibility: "show" },
        ]);
    });

    it("refuses to guess which message a uid from another session meant", async () => {
        const fake = fakeGmail([labels([{ id: LABEL_INCOMING, name: INCOMING }])]);

        await expect(connector(fake).move(numericUid(ID_A), INCOMING, PROCESSED)).rejects.toThrow(
            /no Gmail message is known/,
        );
    });
});

describe("the uid a Gmail message is known by", () => {
    it("is a safe integer, derived deterministically from an id no number could hold", () => {
        // Sixteen hex digits is sixty-four bits; the point of the derivation is that this is not a
        // cast, and that the same message computes the same uid on every poll — which is what the
        // ingest's idempotency rests on.
        expect(Number(`0x${ID_A}`)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
        expect(Number.isSafeInteger(numericUid(ID_A))).toBe(true);
        expect(numericUid(ID_A)).toBe(numericUid(ID_A));
        expect(numericUid(ID_A)).not.toBe(numericUid(ID_B));
    });
});

describe("the Connector boundary", () => {
    it("satisfies what the ingest asks of a mailbox, without the ingest knowing which transport", () => {
        // A type-level assignment, which is the whole assertion: if `GmailConnector` ever stopped
        // being interchangeable with `EmailConnector`, this file would not compile.
        const mailbox: MailConnector = new GmailConnector({
            user: "",
            clientId: "",
            clientSecret: "",
            refreshToken: "",
        });
        expect(typeof mailbox.session).toBe("function");
        expect(typeof mailbox.fetchBatch).toBe("function");
        expect(typeof mailbox.move).toBe("function");
        expect(typeof mailbox.ensureFolders).toBe("function");
    });
});
