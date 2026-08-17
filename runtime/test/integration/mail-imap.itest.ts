import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ImapFlow } from "imapflow";

import type { A12Client } from "../../src/a12/client.js";
import type { UploadedAttachment } from "../../src/a12/content.js";
import { SPECS, ThingRepository } from "../../src/a12/things.js";
import type { MailConfig } from "../../src/config.js";
import { EmailConnector, parseMessage } from "../../src/connectors/email.js";
import type { DocumentThing, Stored } from "../../src/domain/types.js";
import { runMailIngest } from "../../src/watcher/mail.js";
import { MemoryStore } from "../support/memory-store.js";

/**
 * The IMAP half of the Email Connector, against a REAL IMAP server.
 *
 * `parseMessage` has fixtures; `EmailConnector` had nothing — every test of the ingest hands it an
 * in-memory mailbox written from the spec rather than from a server, which is precisely the shape
 * of test that cannot discover the ways a server disagrees with the spec. So this file stands a
 * throwaway GreenMail up on unusual ports, APPENDs the same `.eml` fixtures the parser tests read,
 * and asserts the Connector's four methods and then the whole ingest on top of them.
 *
 * **TLS.** The Connector's `secure: true` default is untouched, and there is no
 * "insecure"/"rejectUnauthorized" flag: GreenMail's IMAPS certificate is self-signed with no SAN
 * and a CN of "GreenMail selfsigned Test Certificate", so no amount of CA trust makes hostname
 * verification pass — reaching it would have meant a `tls` escape hatch, which is exactly the
 * option that ends up in a production config with verification switched off. Instead
 * `MailboxOptions.secure` is optional and defaults to `true`, and only this file passes `false`.
 * Plaintext against a container on localhost is a visible, greppable lie; a TLS option that
 * silently stops verifying is an invisible one.
 */

const CONTAINER = "assistants-mail-itest";
const IMAGE = "greenmail/standalone:2.1.0";
const HOST = "127.0.0.1";
const PORT = 34143;
const USER = "receptionist";
const PASSWORD = "secret";

/**
 * One set of folder names per test, under a unique prefix.
 *
 * The obvious alternative — delete every mailbox between tests — is not available: GreenMail
 * throws a NullPointerException inside `DELETE` when any session still has the mailbox selected,
 * and drops the connection with it. That is a bug in the fake server and says nothing about the
 * Connector, so the tests route around it. The four names keep their real shape, slash included,
 * which is the part under test.
 */
let suffix = 0;
function newFolders(): {
    INCOMING: string;
    PROCESSED: string;
    FAILED: string;
    REJECTED: string;
    ALL: string[];
} {
    const base = `assistant-${++suffix}`;
    const folders = {
        INCOMING: base,
        PROCESSED: `${base}/processed`,
        FAILED: `${base}/failed`,
        REJECTED: `${base}/rejected`,
    };
    return {
        ...folders,
        ALL: [folders.INCOMING, folders.PROCESSED, folders.FAILED, folders.REJECTED],
    };
}

const FIXTURES = fileURLToPath(new URL("../fixtures/mail/", import.meta.url));

const connector = new EmailConnector({
    host: HOST,
    port: PORT,
    user: USER,
    password: PASSWORD,
    secure: false,
});

function docker(...args: string[]): string {
    return execFileSync("docker", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
}

function load(name: string): Buffer {
    return readFileSync(`${FIXTURES}${name}`);
}

/** A bare client, for the setup and the assertions the Connector deliberately cannot make. */
async function raw<T>(work: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = new ImapFlow({
        host: HOST,
        port: PORT,
        secure: false,
        auth: { user: USER, pass: PASSWORD },
        logger: false,
    });
    await client.connect();
    try {
        return await work(client);
    } finally {
        await client.logout().catch(() => undefined);
    }
}

/** Real bytes over the wire: the fixture is APPENDed, exactly as a delivering server would leave it. */
async function deliver(folder: string, fixture: string): Promise<number> {
    return raw(async (client) => {
        const result = await client.append(folder, load(fixture));
        if (!result || typeof result.uid !== "number") throw new Error(`APPEND to ${folder} gave no UID`);
        return result.uid;
    });
}

async function mailboxes(): Promise<string[]> {
    return raw(async (client) => (await client.list()).map((box) => box.path).sort());
}

async function uidsIn(folder: string): Promise<number[]> {
    return raw(async (client) => {
        const lock = await client.getMailboxLock(folder);
        try {
            const uids: number[] = [];
            for await (const message of client.fetch("1:*", { uid: true })) uids.push(message.uid);
            return uids;
        } finally {
            lock.release();
        }
    });
}

beforeAll(async () => {
    docker("rm", "-f", CONTAINER);
    docker(
        "run",
        "-d",
        "--rm",
        "--name",
        CONTAINER,
        "-p",
        `${PORT}:3143`,
        "-e",
        "GREENMAIL_OPTS=-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 " +
            `-Dgreenmail.users=${USER}:${PASSWORD}`,
        IMAGE,
    );

    const deadline = Date.now() + 45_000;
    for (;;) {
        try {
            await raw(async () => undefined);
            return;
        } catch (error) {
            if (Date.now() > deadline) throw error;
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
    }
}, 90_000);

afterAll(() => {
    docker("rm", "-f", CONTAINER);
});

describe("EmailConnector against a real IMAP server", () => {
    it("creates all four folders, and creating them twice does not throw", async () => {
        const f = newFolders();

        await connector.ensureFolders(f.ALL);
        expect(await mailboxes()).toEqual(expect.arrayContaining(f.ALL));

        // Idempotency is the claim: `createFolder` swallows the "already exists" failure rather
        // than parsing a server's prose for it, and this is the only place that can be proven.
        await expect(connector.ensureFolders(f.ALL)).resolves.toBeUndefined();
        const after = await mailboxes();
        expect(after).toEqual(expect.arrayContaining(f.ALL));
        // Created once, not twice under a mangled name.
        expect(after.filter((box) => box.startsWith(f.INCOMING))).toHaveLength(4);
    });

    /**
     * The separator finding, pinned so it cannot rot.
     *
     * GreenMail's hierarchy delimiter is `.`, not `/`. `assistant/processed` therefore is not a
     * child of `assistant` here — it is one flat mailbox whose *name* contains a slash, which is
     * why it can be created before `assistant` exists at all. Gmail's delimiter is `/`, so on
     * Gmail the same four names really are a label and three sub-labels. Both work, but only
     * because nothing in the Connector or the ingest ever asks about hierarchy: the four folder
     * names are opaque strings passed straight through, and `/` is a Gmail-shaped convention
     * rather than a portable one. That is what keeps `assistant/processed` working here, and it
     * is what this test guards.
     */
    it("treats the slash as part of the name, not as hierarchy — this server's delimiter is '.'", async () => {
        const f = newFolders();
        const delimiter = await raw(
            async (client) => (await client.list()).find((box) => box.path === "INBOX")?.delimiter,
        );
        expect(delimiter).toBe(".");

        // Only the child, never the parent: on a `.`-delimited server this must still succeed.
        await connector.ensureFolders([f.PROCESSED]);
        const boxes = await mailboxes();
        expect(boxes).toContain(f.PROCESSED);
        expect(boxes).not.toContain(f.INCOMING);
    });

    it("fetches real messages with a UID, the raw bytes and an INTERNALDATE", async () => {
        const f = newFolders();
        await connector.ensureFolders([f.INCOMING]);
        const uid = await deliver(f.INCOMING, "plain-text.eml");

        const [message, ...rest] = await connector.fetch(f.INCOMING, 10);

        expect(rest).toEqual([]);
        expect(message?.uid).toBe(uid);
        expect(Buffer.isBuffer(message?.raw)).toBe(true);
        // The bytes are the fixture's, not a re-serialisation of a parsed object.
        expect(message?.raw.toString("utf8")).toContain("Message-ID: <plain-001@example.com>");
        expect(message?.raw.toString("utf8")).toContain("Stromrechnung");
        expect(message?.internalDate).toBeInstanceOf(Date);
        expect(Number.isNaN(message!.internalDate.getTime())).toBe(false);
    });

    it("honours max and leaves the rest for the next poll", async () => {
        const f = newFolders();
        await connector.ensureFolders([f.INCOMING]);
        await deliver(f.INCOMING, "plain-text.eml");
        await deliver(f.INCOMING, "forward-one-pdf.eml");
        await deliver(f.INCOMING, "html-only.eml");

        expect(await connector.fetch(f.INCOMING, 2)).toHaveLength(2);
        expect(await connector.fetch(f.INCOMING, 10)).toHaveLength(3);
    });

    it("reads envelopeFrom off the server's ENVELOPE, and it agrees with the parsed From: header", async () => {
        const f = newFolders();
        await connector.ensureFolders([f.INCOMING]);
        await deliver(f.INCOMING, "plain-text.eml");

        const [message] = await connector.fetch(f.INCOMING, 1);
        // The display name is stripped and the case flattened — the fixture says
        // `Anna Beispiel <Anna.Beispiel@example.com>`.
        expect(message?.envelopeFrom).toBe("anna.beispiel@example.com");

        const parsed = await parseMessage(
            message!.raw,
            message!.uid,
            message!.internalDate,
            25 * 1024 * 1024,
            message!.origin,
        );
        // The two halves of the ingest's gate must agree about what an address *is*.
        expect(parsed.from).toBe(message?.envelopeFrom);
    });

    it("moves a message: gone from the source, present in the destination", async () => {
        const f = newFolders();
        await connector.ensureFolders([f.INCOMING, f.PROCESSED]);
        const uid = await deliver(f.INCOMING, "plain-text.eml");

        await connector.move(uid, f.INCOMING, f.PROCESSED);

        expect(await uidsIn(f.INCOMING)).toEqual([]);
        expect(await uidsIn(f.PROCESSED)).toHaveLength(1);
    });

    /** THE ORDERING PROPERTY: what has been moved must never come back on the next poll. */
    it("does not return a moved message on the next fetch", async () => {
        const f = newFolders();
        await connector.ensureFolders([f.INCOMING, f.PROCESSED]);
        await deliver(f.INCOMING, "plain-text.eml");

        const [message] = await connector.fetch(f.INCOMING, 10);
        await connector.move(message!.uid, f.INCOMING, f.PROCESSED);

        expect(await connector.fetch(f.INCOMING, 10)).toEqual([]);
    });

    /**
     * A move to a folder that does not exist. The documented behaviour is that `move` creates it
     * first — and against a real server it really does, rather than failing with the `[TRYCREATE]`
     * the protocol would otherwise answer with.
     */
    it("creates the destination when it is missing, rather than failing the move", async () => {
        const f = newFolders();
        await connector.ensureFolders([f.INCOMING]);
        const uid = await deliver(f.INCOMING, "plain-text.eml");
        expect(await mailboxes()).not.toContain(f.FAILED);

        await connector.move(uid, f.INCOMING, f.FAILED);

        expect(await mailboxes()).toContain(f.FAILED);
        expect(await uidsIn(f.FAILED)).toHaveLength(1);
        expect(await uidsIn(f.INCOMING)).toEqual([]);
    });

    it("returns [] for an empty folder rather than throwing", async () => {
        const f = newFolders();
        await connector.ensureFolders([f.INCOMING]);
        expect(await connector.fetch(f.INCOMING, 20)).toEqual([]);
    });
});

/**
 * The Content Store, faked the way `test/watcher/mail.test.ts` fakes it — the bytes are kept in a
 * list. It is re-declared rather than imported because that file declares it privately, and this
 * file may not edit it.
 */
class FakeContentStore {
    readonly uploaded: Array<{
        filename: string;
        mimeType: string;
        bytes: number;
    }> = [];

    async upload(filename: string, mimeType: string, bytes: Buffer): Promise<UploadedAttachment> {
        this.uploaded.push({ filename, mimeType, bytes: bytes.length });
        return {
            original_filename: filename,
            internal_filename: `stored-${filename}`,
            attachment_id: `attachment-${this.uploaded.length}`,
            size: bytes.length,
            mime_type: mimeType,
        };
    }
}

function mailConfig(f: ReturnType<typeof newFolders>): MailConfig {
    return {
        host: HOST,
        port: PORT,
        user: USER,
        password: PASSWORD,
        folderIncoming: f.INCOMING,
        folderProcessed: f.PROCESSED,
        folderFailed: f.FAILED,
        folderRejected: f.REJECTED,
        allowedSenders: ["user@example.com"],
        pollIntervalMs: 60_000,
        maxPerPoll: 20,
        maxAttachmentBytes: 25 * 1024 * 1024,
    };
}

describe("runMailIngest against a real IMAP server", () => {
    let things: ThingRepository;
    let content: FakeContentStore;
    let folders: ReturnType<typeof newFolders>;

    beforeEach(async () => {
        things = new ThingRepository(new MemoryStore() as unknown as A12Client);
        content = new FakeContentStore();
        folders = newFolders();
        await things.create(SPECS.Operation_DM, {
            key: "email.receive",
            name: "Receive email",
            system: "Email",
            kind: "connector",
            mutating: true,
            enabled: true,
        });
    });

    function documents(): Promise<Stored<DocumentThing>[]> {
        return things.search<DocumentThing>(SPECS.Document_DM, undefined, 100);
    }

    function ingest() {
        return runMailIngest({
            config: mailConfig(folders),
            connector,
            content,
            things,
        });
    }

    it("turns an allowed sender's mail into a Document and leaves it in processed", async () => {
        // `ensureFolders` is the ingest's own first step; only the incoming folder has to exist
        // before it, because a message has to be delivered into it.
        await connector.ensureFolders([folders.INCOMING]);
        await deliver(folders.INCOMING, "forward-one-pdf.eml");

        const summary = await ingest();

        expect(summary).toEqual({
            fetched: 1,
            rejected: 0,
            created: 1,
            skipped: 0,
            failed: 0,
        });
        const [document] = await documents();
        expect(document?.data.source).toBe("email");
        expect(document?.data.externalRef).toBe("<fwd-one@example.com>#1");
        expect(document?.data.title).toBe("Fwd: Zahnarztrechnung");
        expect(content.uploaded).toHaveLength(1);

        expect(await uidsIn(folders.INCOMING)).toEqual([]);
        expect(await uidsIn(folders.PROCESSED)).toHaveLength(1);
    });

    it("puts a sender nobody allowed in rejected, and creates nothing", async () => {
        await connector.ensureFolders([folders.INCOMING]);
        await deliver(folders.INCOMING, "html-only.eml"); // billing@telco.example, not on the list

        const summary = await ingest();

        expect(summary).toEqual({
            fetched: 1,
            rejected: 1,
            created: 0,
            skipped: 0,
            failed: 0,
        });
        expect(await documents()).toHaveLength(0);
        expect(await uidsIn(folders.INCOMING)).toEqual([]);
        expect(await uidsIn(folders.REJECTED)).toHaveLength(1);
    });

    /** Polling twice creates one Document — the property the whole move-last ordering exists for. */
    it("creates one Document when the letterbox is polled twice", async () => {
        await connector.ensureFolders([folders.INCOMING]);
        await deliver(folders.INCOMING, "forward-one-pdf.eml");

        const first = await ingest();
        const second = await ingest();

        expect(first.created).toBe(1);
        expect(second).toEqual({
            fetched: 0,
            rejected: 0,
            created: 0,
            skipped: 0,
            failed: 0,
        });
        expect(await documents()).toHaveLength(1);
    });
});
