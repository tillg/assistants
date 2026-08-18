import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { A12Client } from "../../src/a12/client.js";
import type { UploadedAttachment } from "../../src/a12/content.js";
import { SPECS, ThingRepository } from "../../src/a12/things.js";
import type {
    FetchedMessage,
    FetchResult,
    MailSession,
    MessageOrigin,
    OversizedMessage,
} from "../../src/connectors/email.js";
import type { MailConfig } from "../../src/config.js";
import type { DocumentThing, Stored } from "../../src/domain/types.js";
import type { LoopDriver } from "../../src/loop/advance.js";
import { log } from "../../src/log.js";
import {
    ARRIVAL_MAX_PAGES,
    isAllowedSender,
    MailboxUnreachable,
    MAX_EXTRACTED_TEXT_LENGTH,
    runMailIngest,
} from "../../src/watcher/mail.js";
import { Watcher } from "../../src/watcher/watcher.js";
import { MemoryStore } from "../support/memory-store.js";

/**
 * The mail ingest, against real MIME, a real ThingStore and a mailbox that is not there.
 *
 * Two of the three halves are the real thing: the messages are the same `.eml` fixtures the
 * Connector's own tests parse — so `parseMessage` runs for real and nothing here asserts against a
 * hand-built object graph — and the store is `MemoryStore` behind the real `ThingRepository`, so
 * `ExternalRef` queries, idempotency keys and the A12 document shape are all exercised rather than
 * stubbed. Only IMAP is faked, because it is the one part that needs a server, and the whole reason
 * the Connector is split in two is that everything above it does not.
 *
 * The two tests that matter most are the two the architecture says protect the User's invoice:
 * **polling twice creates one Document**, and **a message whose Documents were created but which
 * was never moved creates nothing on the next poll**. Both are consequences of moving the message
 * last, and both would pass silently if the ordering were reversed and the mailbox happened to be
 * reachable — which is exactly why they are pinned here.
 */

/**
 * The text-layer reader, real in every test but one.
 *
 * `readTextLayer` documents itself as never throwing, so the one behaviour that cannot be provoked
 * with bytes on disk is the day that stops being true. This wraps the **real** function and injects
 * a throw only when a test asks for one — the same shape as `FakeContentStore.refuse` and
 * `FakeMailbox.swallowNextMove` below, which is to say fault injection into an otherwise honest
 * collaborator rather than a stub standing in for it.
 */
const reader = vi.hoisted(() => ({
    throws: false,
    maxPages: undefined as number | undefined,
}));
vi.mock("../../src/readers/textLayer.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/readers/textLayer.js")>();
    return {
        ...actual,
        // EVERY argument is forwarded, and the last one is recorded. A wrapper that drops an
        // argument is not a wrapper: forget `maxPages` here and the ingest's page cap is never
        // exercised by any test, so it can be deleted without a single failure — which is precisely
        // how a cap that bounds work inside the scan loop goes missing.
        readTextLayer: (bytes: Buffer, sparseBelow?: number, maxPages?: number) => {
            reader.maxPages = maxPages;
            if (reader.throws) throw new Error("pdfjs fell over");
            return actual.readTextLayer(bytes, sparseBelow, maxPages);
        },
    };
});

const FIXTURES = fileURLToPath(new URL("../fixtures/mail/", import.meta.url));
const PDF_FIXTURES = fileURLToPath(new URL("../fixtures/pdf/", import.meta.url));

const INCOMING = "assistant";
const PROCESSED = "assistant/processed";
const FAILED = "assistant/failed";
const REJECTED = "assistant/rejected";

/** Whatever the server said. Only used when a message carries no usable `Date`. */
const INTERNAL_DATE = new Date("2026-06-01T10:00:00.000Z");

function load(name: string): Buffer {
    return readFileSync(`${FIXTURES}${name}`);
}

/**
 * One message as IMAP hands it over — envelope included.
 *
 * The envelope sender is read out of the fixture's own `From:` header rather than passed in, so a
 * fake message says the same thing twice, exactly as an honest one does. A test that wants the two
 * to disagree — a forged header behind an allowed envelope — says so explicitly.
 */
function fetched(uid: number, fixture: string, envelopeFrom?: string): FetchedMessage {
    const raw = load(fixture);
    return {
        uid,
        raw,
        internalDate: INTERNAL_DATE,
        envelopeFrom: envelopeFrom ?? headerFrom(raw),
    };
}

function headerFrom(raw: Buffer): string {
    const value = /^From:\s*(.*)$/im.exec(raw.toString("utf8"))?.[1] ?? "";
    const angled = /<([^>]*)>/.exec(value);
    return (angled?.[1] ?? value).trim().toLowerCase();
}

/**
 * A message whose bytes explode the moment anybody reads them.
 *
 * It is how "the parser never ran" is asserted as a fact about the ingest rather than as a fact
 * about a spy: `handleMessage` touches `raw` only to parse it, so a rejection that completes proves
 * no MIME was decoded on behalf of a sender nobody vouched for.
 */
function unreadable(uid: number, envelopeFrom: string): FetchedMessage {
    const message = { uid, internalDate: INTERNAL_DATE, envelopeFrom };
    Object.defineProperty(message, "raw", {
        get(): Buffer {
            throw new Error("the raw bytes of a rejected mail were read");
        },
    });
    return message as FetchedMessage;
}

/**
 * A mail from an allowed sender that carries no `Message-ID` at all.
 *
 * Perfectly ordinary post — small senders' order confirmations arrive like this — and the only kind
 * of message whose identity has to be synthesised from the mailbox it was found in.
 */
function noMessageId(uid: number, subject: string): FetchedMessage {
    const raw = Buffer.from(
        [
            "From: user@example.com",
            "To: receptionist@example.com",
            `Subject: ${subject}`,
            "Date: Tue, 13 Jan 2026 17:02:11 +0000",
            "MIME-Version: 1.0",
            "Content-Type: text/plain; charset=utf-8",
            "",
            `${subject} — der Text der Nachricht.`,
            "",
        ].join("\r\n"),
    );
    return {
        uid,
        raw,
        internalDate: INTERNAL_DATE,
        envelopeFrom: "user@example.com",
    };
}

/**
 * A PDF of `pages` pages, each saying which one it is.
 *
 * Built rather than committed because what it is for is a document *longer than the arrival page
 * cap*, and a fixture of that length would be a file nobody could read to check the test — whereas
 * this is twelve lines whose page count is the number in the call.
 */
function manyPagePdf(pages: number): Buffer {
    // 1 catalogue, 2 page tree, 3 font, then one page object and one content stream per page.
    const objects: string[] = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pages} >>`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    for (let page = 1; page <= pages; page++) {
        const stream = `BT\n/F1 11 Tf\n56 780 Td\n(Seite ${page} von ${pages}) Tj\nET`;
        objects.push(
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + (page - 1) * 2} 0 R >>`,
            `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
        );
    }

    let body = "%PDF-1.4\n";
    const offsets: number[] = [];
    objects.forEach((object, index) => {
        offsets.push(body.length);
        body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });

    const startxref = body.length;
    const table = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
    const trailer = `<< /Size ${objects.length + 1} /Root 1 0 R >>`;
    return Buffer.from(
        `${body}xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${table}trailer\n${trailer}\nstartxref\n${startxref}\n%%EOF\n`,
        "latin1",
    );
}

/** A forward with one PDF attached, built here because the PDF is what the test is about. */
function withPdf(uid: number, pdf: string, options: { body?: string; messageId?: string } = {}): FetchedMessage {
    return withPdfBytes(uid, pdf, readFileSync(`${PDF_FIXTURES}${pdf}`), options);
}

function withPdfBytes(
    uid: number,
    pdf: string,
    content: Buffer,
    options: { body?: string; messageId?: string } = {},
): FetchedMessage {
    const bytes = content.toString("base64");
    const raw = Buffer.from(
        [
            "From: user@example.com",
            `Message-ID: <${options.messageId ?? pdf}@example.com>`,
            "Subject: Fwd: Rechnung",
            "Date: Tue, 13 Jan 2026 17:02:11 +0000",
            "MIME-Version: 1.0",
            'Content-Type: multipart/mixed; boundary="grenze"',
            "",
            "--grenze",
            "Content-Type: text/plain; charset=utf-8",
            "",
            options.body ?? "",
            "--grenze",
            `Content-Type: application/pdf; name="${pdf}"`,
            `Content-Disposition: attachment; filename="${pdf}"`,
            "Content-Transfer-Encoding: base64",
            "",
            ...(bytes.match(/.{1,76}/g) ?? []),
            "--grenze--",
            "",
        ].join("\r\n"),
    );
    return {
        uid,
        raw,
        internalDate: INTERNAL_DATE,
        envelopeFrom: "user@example.com",
    };
}

/**
 * A mailbox with folders, connections and no protocol.
 *
 * It really moves messages between folders and really refuses a folder it has never been told
 * about, which is what makes "a missing folder is created rather than throwing" a claim about the
 * ingest instead of a claim about the fake. It records every call so a disabled ingest can be shown
 * to have touched nothing at all.
 *
 * **It is as strict as the server, deliberately.** Three of its rules exist only to stop a bug of
 * exactly the kind these tests are about from passing:
 *
 *   - **Nothing works without a session.** Every operation goes through {@link session}, and a
 *     session that has been closed refuses to do anything. A fake that lets the ingest fetch from
 *     thin air cannot tell "one connection per poll" from "one connection per call" — which is the
 *     whole subject of the change.
 *   - **`fetchBatch` declines messages it decides are too large**, exactly as the real one does on
 *     the server's `RFC822.SIZE`, and those messages stay in the folder. If the ingest does not file
 *     them, the next poll sees them again — and one of the tests below asserts that it does not.
 *   - **It stamps the origin**, from its own host, the folder and the current `UIDVALIDITY`, the way
 *     `ConnectedSession.fetchBatch` does. A fake that omits it makes every `Message-ID`-less message
 *     silently fall back to `<uid.N@local>`, which is the collision the origin exists to prevent.
 */
class FakeMailbox {
    readonly folders = new Map<string, FetchedMessage[]>();
    readonly calls: string[] = [];
    /** The host a stamped {@link MessageOrigin} names — the same one `mailConfig()` connects to. */
    host = "imap.example.com";
    /**
     * The incoming folder's `UIDVALIDITY`. Change it between polls to be the server that dropped and
     * recreated the `assistant` label and is now handing out UID 1 again.
     */
    uidValidity = "1";
    /** UIDs the fetch will decline to download, mapped to the size it reports for them. */
    readonly tooLarge = new Map<number, number>();
    /** What `fetchBatch` reports about its byte budget. */
    budgetExhausted = false;
    /**
     * Swallow the next `move`, leaving the message where it was. That is the crash between
     * `ADD_DOCUMENT` and `MOVE` — the one window the move-last ordering exists to survive.
     */
    swallowNextMove = false;
    /**
     * Throw on the next `move`, leaving the message where it was.
     *
     * Different from {@link swallowNextMove} in the one way that matters here: the caller *finds
     * out*. That is the transient IMAP error on the last statement of an otherwise successful
     * message — the one that used to change the message's verdict.
     */
    refuseNextMove = false;
    /** Fault injection for the mailbox *as a whole*: the three wholesale failures, one field each. */
    failConnect: string | undefined;
    failFetch: string | undefined;
    failEnsureFolders: string | undefined;

    constructor(existingFolders: readonly string[] = [INCOMING]) {
        for (const folder of existingFolders) this.folders.set(folder, []);
    }

    put(folder: string, ...messages: FetchedMessage[]): void {
        this.folders.set(folder, [...(this.folders.get(folder) ?? []), ...messages]);
    }

    uids(folder: string): number[] {
        return (this.folders.get(folder) ?? []).map((message) => message.uid);
    }

    /** How many connections were opened — the number the one-connection-per-poll change is about. */
    get sessionsOpened(): number {
        return this.calls.filter((call) => call === "session:open").length;
    }

    /**
     * One connection, lent to `work` and closed afterwards — and dead the moment it is.
     *
     * The closed check is the point: it is what makes a session an actual scope rather than a
     * decorative wrapper around the same three methods.
     */
    async session<T>(work: (session: MailSession) => Promise<T>): Promise<T> {
        this.calls.push("session:open");
        if (this.failConnect) throw new Error(this.failConnect);
        let open = true;
        const alive = <A extends unknown[], R>(operation: (...args: A) => Promise<R>) => {
            return async (...args: A): Promise<R> => {
                if (!open) throw new Error("the session is closed");
                return operation(...args);
            };
        };
        try {
            return await work({
                fetch: alive(async (folder: string, max: number) => (await this.fetchIn(folder, max)).messages),
                fetchBatch: alive((folder: string, max: number) => this.fetchIn(folder, max)),
                move: alive((uid: number, from: string, to: string) => this.moveIn(uid, from, to)),
                ensureFolders: alive((folders: readonly string[]) => this.ensureIn(folders)),
            });
        } finally {
            open = false;
            this.calls.push("session:close");
        }
    }

    /** The one-shot forms, each its own session — the same shape the real connector has. */
    async ensureFolders(folders: readonly string[]): Promise<void> {
        await this.session((session) => session.ensureFolders(folders));
    }

    async fetch(folder: string, max: number): Promise<FetchedMessage[]> {
        return this.session((session) => session.fetch(folder, max));
    }

    async fetchBatch(folder: string, max: number): Promise<FetchResult> {
        return this.session((session) => session.fetchBatch(folder, max));
    }

    async move(uid: number, fromFolder: string, toFolder: string): Promise<void> {
        await this.session((session) => session.move(uid, fromFolder, toFolder));
    }

    private async ensureIn(folders: readonly string[]): Promise<void> {
        this.calls.push(`ensureFolders:${folders.join(",")}`);
        if (this.failEnsureFolders) throw new Error(this.failEnsureFolders);
        for (const folder of folders) if (!this.folders.has(folder)) this.folders.set(folder, []);
    }

    private async fetchIn(folder: string, max: number): Promise<FetchResult> {
        this.calls.push(`fetchBatch:${folder}:${max}`);
        if (this.failFetch) throw new Error(this.failFetch);
        const rows = this.folders.get(folder);
        if (!rows) throw new Error(`No folder ${folder}`);

        const origin: MessageOrigin = {
            host: this.host,
            folder,
            uidValidity: this.uidValidity,
        };
        const messages: FetchedMessage[] = [];
        const oversized: OversizedMessage[] = [];
        // `max` bounds the *candidates*, as it does on the server: a message that is declined for
        // its size has still used up one of the poll's slots, which is why it has to be filed.
        for (const message of rows.slice(0, max)) {
            const size = this.tooLarge.get(message.uid);
            if (size !== undefined) {
                oversized.push({
                    uid: message.uid,
                    size,
                    envelopeFrom: message.envelopeFrom,
                });
                continue;
            }
            messages.push(withOrigin(message, origin));
        }
        return { messages, oversized, budgetExhausted: this.budgetExhausted };
    }

    private async moveIn(uid: number, fromFolder: string, toFolder: string): Promise<void> {
        this.calls.push(`move:${uid}:${fromFolder}->${toFolder}`);
        if (this.refuseNextMove) {
            this.refuseNextMove = false;
            throw new Error(`the server refused to move ${uid} to ${toFolder}`);
        }
        if (this.swallowNextMove) {
            this.swallowNextMove = false;
            return;
        }
        const source = this.folders.get(fromFolder);
        const target = this.folders.get(toFolder);
        if (!source) throw new Error(`No folder ${fromFolder}`);
        if (!target) throw new Error(`No folder ${toFolder}`);
        const moving = source.find((message) => message.uid === uid);
        if (!moving) throw new Error(`No message ${uid} in ${fromFolder}`);
        this.folders.set(
            fromFolder,
            source.filter((message) => message.uid !== uid),
        );
        target.push(moving);
    }
}

/**
 * The message as the fetch hands it over: itself, plus where it was found.
 *
 * Copied by property *descriptor* rather than spread, because {@link unreadable}'s `raw` is a getter
 * that throws on purpose and spreading would read it — turning the one test that proves a stranger's
 * MIME is never parsed into a test that parses it here instead.
 */
function withOrigin(message: FetchedMessage, origin: MessageOrigin): FetchedMessage {
    const copy = {} as FetchedMessage;
    Object.defineProperties(copy, Object.getOwnPropertyDescriptors(message));
    Object.defineProperty(copy, "origin", { value: origin, enumerable: true });
    return copy;
}

/** A Content Store that keeps the bytes in a list and can be told to refuse one file. */
class FakeContentStore {
    readonly uploaded: Array<{
        filename: string;
        mimeType: string;
        bytes: number;
    }> = [];
    /** The filename to refuse, so a failure can be provoked *mid*-message rather than before it. */
    refuse: string | undefined;

    async upload(filename: string, mimeType: string, bytes: Buffer): Promise<UploadedAttachment> {
        if (filename === this.refuse) throw new Error(`the Content Store refused ${filename}`);
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

function mailConfig(overrides: Partial<MailConfig> = {}): MailConfig {
    return {
        host: "imap.example.com",
        port: 993,
        user: "receptionist@example.com",
        password: "app-password",
        folderIncoming: INCOMING,
        folderProcessed: PROCESSED,
        folderFailed: FAILED,
        folderRejected: REJECTED,
        allowedSenders: ["user@example.com"],
        pollIntervalMs: 60_000,
        maxPerPoll: 20,
        maxAttachmentBytes: 25 * 1024 * 1024,
        ...overrides,
    };
}

let store: MemoryStore;
let things: ThingRepository;
let content: FakeContentStore;

beforeEach(() => {
    store = new MemoryStore();
    things = new ThingRepository(store as unknown as A12Client);
    content = new FakeContentStore();
    reader.throws = false;
    reader.maxPages = undefined;
});

/** The Operation Thing that is the ingest's switch, created the way bootstrap creates it. */
async function seedOperation(enabled: boolean): Promise<void> {
    await things.create(SPECS.Operation_DM, {
        key: "email.receive",
        name: "Receive email",
        system: "Email",
        kind: "connector",
        mutating: true,
        enabled,
    });
}

function documents(): Promise<Stored<DocumentThing>[]> {
    return things.search<DocumentThing>(SPECS.Document_DM, undefined, 100);
}

function ingest(connector: FakeMailbox, config: MailConfig = mailConfig()) {
    return runMailIngest({ config, connector, content, things });
}

describe("isAllowedSender", () => {
    it("allows an address that is on the list", () => {
        expect(isAllowedSender("user@example.com", ["user@example.com"])).toBe(true);
    });

    it("ignores case on both sides", () => {
        expect(isAllowedSender("User@Example.COM", ["user@example.com"])).toBe(true);
        expect(isAllowedSender("user@example.com", ["USER@EXAMPLE.COM"])).toBe(true);
    });

    it("ignores a display name around the address", () => {
        expect(isAllowedSender('"Dr X" <a@b.de>', ["a@b.de"])).toBe(true);
        expect(isAllowedSender("Anna Beispiel <anna@example.com>", ["anna@example.com"])).toBe(true);
    });

    /**
     * THE SAFETY PROPERTY. **An empty allowlist allows nobody.**
     *
     * Never relax this test. A default that fails open on a public address turns spam into
     * Conversations and LLM spend on the first day it is misconfigured, and the mailbox is the
     * first untrusted input this system has.
     */
    it("allows NOBODY when the allowlist is empty", () => {
        expect(isAllowedSender("user@example.com", [])).toBe(false);
        expect(isAllowedSender("", [])).toBe(false);
    });

    it("does not match an address that merely contains an allowed one", () => {
        expect(isAllowedSender("evil-user@example.com.attacker.io", ["user@example.com"])).toBe(false);
        expect(isAllowedSender("user@example.com.attacker.io", ["user@example.com"])).toBe(false);
        expect(isAllowedSender("notuser@example.com", ["user@example.com"])).toBe(false);
    });

    it("refuses a sender with no address at all", () => {
        expect(isAllowedSender("", ["user@example.com"])).toBe(false);
    });
});

describe("runMailIngest", () => {
    it("polls over Gmail with no IMAP host at all", async () => {
        // The guard asks the transport, not whether a host string is non-empty. A Gmail deployment
        // has no IMAP host and needs none; this used to require the literal sentinel "gmail".
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, fetched(931, "forward-one-pdf.eml"));

        const summary = await ingest(
            mailbox,
            mailConfig({
                host: "",
                transport: "gmail",
                gmail: {
                    user: "someone@gmail.com",
                    clientId: "a-client",
                    clientSecret: "a-secret",
                    refreshToken: "1//0g-a-refresh-token",
                },
            }),
        );

        expect(summary.created).toBe(1);
        expect(mailbox.uids(PROCESSED)).toEqual([931]);
    });

    it("does nothing when the transport is Gmail but no grant was pasted in", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, fetched(932, "forward-one-pdf.eml"));

        const summary = await ingest(
            mailbox,
            mailConfig({
                host: "",
                transport: "gmail",
                gmail: { user: "", clientId: "", clientSecret: "", refreshToken: "" },
            }),
        );

        expect(summary.fetched).toBe(0);
        expect(mailbox.calls).toEqual([]);
    });

    it("does nothing at all, and touches no mailbox, when the host is empty", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, fetched(1, "forward-one-pdf.eml"));

        const summary = await ingest(mailbox, mailConfig({ host: "" }));

        expect(summary).toEqual({
            fetched: 0,
            rejected: 0,
            created: 0,
            skipped: 0,
            failed: 0,
        });
        expect(mailbox.calls).toEqual([]);
        expect(await documents()).toHaveLength(0);
    });

    it("turns a mail from an allowed sender into a Document and moves it to processed", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, fetched(7, "forward-one-pdf.eml"));

        const summary = await ingest(mailbox);

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
        expect(document?.data.mediaType).toBe("application/pdf");
        expect(document?.data.extractedText).toContain("Zahnarztrechnung");
        // `yyyy-MM-dd'T'HH:mm:ss` — no milliseconds, no zone. That is what `Document_DM`'s
        // `DateTimeType` declares, and an A12 server refuses anything else outright.
        //
        // This assertion previously read `"2026-01-13T17:02:11.000Z"`, which is what the code
        // produced and what no store would accept: the in-memory store these tests write through
        // does not validate the format, so a green suite sat on top of a Document that could never
        // have been created for real. It was found by ingesting an actual forwarded invoice.
        expect(document?.data.receivedAt).toBe("2026-01-13T17:02:11");
        expect(document?.data.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);

        expect(mailbox.uids(INCOMING)).toEqual([]);
        expect(mailbox.uids(PROCESSED)).toEqual([7]);
    });

    it("puts the uploaded attachment on the Document's attachment group", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, fetched(7, "forward-one-pdf.eml"));

        await ingest(mailbox);

        expect(content.uploaded).toEqual([
            {
                filename: "rechnung.pdf",
                mimeType: "application/pdf",
                bytes: expect.any(Number),
            },
        ]);
        // Read the raw stored document, because the group is what `ADD_DOCUMENT` had to carry —
        // asserting on our own projection of it would prove nothing about what reached the store.
        const [row] = [...store.rows.values()].filter((entry) => entry.documentModelName === "Document_DM");
        const body = (row?.document as Record<string, Record<string, unknown>>)["Document"] ?? {};
        expect(body["Attachment"]).toMatchObject({
            original_filename: "rechnung.pdf",
            internal_filename: "stored-rechnung.pdf",
            attachment_id: "attachment-1",
            mime_type: "application/pdf",
        });
        // `attachment_id` and `content` are mutually exclusive on `Document_DM`.
        expect((body["Attachment"] as Record<string, unknown>)["content"]).toBeUndefined();
    });

    it("creates nothing for a sender who is not on the allowlist, and moves the mail to rejected", async () => {
        const mailbox = new FakeMailbox();
        // plain-text.eml is from anna.beispiel@example.com; only user@example.com is allowed.
        mailbox.put(INCOMING, fetched(3, "plain-text.eml"));

        const summary = await ingest(mailbox);

        expect(summary).toEqual({
            fetched: 1,
            rejected: 1,
            created: 0,
            skipped: 0,
            failed: 0,
        });
        expect(await documents()).toHaveLength(0);
        expect(content.uploaded).toEqual([]);
        expect(mailbox.uids(REJECTED)).toEqual([3]);
        expect(mailbox.uids(INCOMING)).toEqual([]);
    });

    it("turns a two-attachment mail into two Documents that share the body text", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, fetched(9, "forward-two-pdfs.eml"));

        const summary = await ingest(mailbox);

        expect(summary.created).toBe(2);
        const created = await documents();
        expect(created.map((document) => document.data.externalRef).sort()).toEqual([
            "<fwd-two@example.com>#1",
            "<fwd-two@example.com>#2",
        ]);
        // Distinguishable, and that is the point. These two titles were previously identical, which
        // is how a real three-attachment invoice mail came to look like the same Document filed
        // three times — the refs differed and a second poll created nothing, but a human identifies
        // a Thing by its title.
        expect(created.map((document) => document.data.title).sort()).toEqual([
            "Fwd: zwei Rechnungen — erste.pdf",
            "Fwd: zwei Rechnungen — zweite.pdf",
        ]);
        expect(new Set(created.map((document) => document.data.extractedText)).size).toBe(1);
        expect(mailbox.uids(PROCESSED)).toEqual([9]);
    });

    it("moves a mail whose ingest threw to failed, and does not see it again", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, fetched(11, "forward-two-pdfs.eml"));
        // The *second* attachment is refused, so the failure happens after one Document is real.
        content.refuse = "zweite.pdf";

        const summary = await ingest(mailbox);

        expect(summary).toEqual({
            fetched: 1,
            rejected: 0,
            created: 1,
            skipped: 0,
            failed: 1,
        });
        expect(mailbox.uids(FAILED)).toEqual([11]);
        expect(mailbox.uids(INCOMING)).toEqual([]);
        // The Document that did land stays landed: it is a real Thing with a real ExternalRef.
        expect(await documents()).toHaveLength(1);

        const second = await ingest(mailbox);
        expect(second.fetched).toBe(0);
        expect(await documents()).toHaveLength(1);
    });

    it("creates one Document when the same mail is polled twice", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, fetched(13, "forward-one-pdf.eml"));
        // The crash the ordering exists for: every Document is created, then the process dies
        // before the message is moved. Next poll finds the same mail still in `assistant`.
        mailbox.swallowNextMove = true;

        const first = await ingest(mailbox);
        expect(first.created).toBe(1);
        expect(mailbox.uids(INCOMING)).toEqual([13]);

        const second = await ingest(mailbox);

        expect(second).toEqual({
            fetched: 1,
            rejected: 0,
            created: 0,
            skipped: 1,
            failed: 0,
        });
        expect(await documents()).toHaveLength(1);
        expect(content.uploaded).toHaveLength(1);
        expect(mailbox.uids(PROCESSED)).toEqual([13]);
    });

    it("creates nothing and moves to processed when the mail is put back in incoming by hand", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, fetched(15, "forward-two-pdfs.eml"));

        await ingest(mailbox);
        expect(mailbox.uids(PROCESSED)).toEqual([15]);

        // The User (or a retry after a failure) moves it back. Nothing new may be created.
        await mailbox.move(15, PROCESSED, INCOMING);
        const second = await ingest(mailbox);

        expect(second).toEqual({
            fetched: 1,
            rejected: 0,
            created: 0,
            skipped: 2,
            failed: 0,
        });
        expect(await documents()).toHaveLength(2);
        expect(mailbox.uids(PROCESSED)).toEqual([15]);
    });

    it("takes no more than maxPerPoll messages in one poll", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(
            INCOMING,
            fetched(21, "forward-one-pdf.eml"),
            fetched(22, "plain-text.eml"),
            fetched(23, "forward-two-pdfs.eml"),
        );

        const summary = await ingest(mailbox, mailConfig({ maxPerPoll: 2 }));

        expect(summary.fetched).toBe(2);
        expect(mailbox.calls).toContain(`fetchBatch:${INCOMING}:2`);
        expect(mailbox.uids(INCOMING)).toEqual([23]);
    });

    it("creates the folders it needs rather than throwing when they are missing", async () => {
        // A mailbox with nothing but the incoming label — the state of a fresh account.
        const mailbox = new FakeMailbox([INCOMING]);
        mailbox.put(INCOMING, fetched(31, "plain-text.eml"));

        const summary = await ingest(mailbox);

        expect([...mailbox.folders.keys()].sort()).toEqual([INCOMING, FAILED, PROCESSED, REJECTED].sort());
        expect(summary.rejected).toBe(1);
        expect(mailbox.uids(REJECTED)).toEqual([31]);
    });

    it("carries on with the next message when one of them fails", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, fetched(41, "forward-one-pdf.eml"), fetched(42, "forward-two-pdfs.eml"));
        content.refuse = "rechnung.pdf";

        const summary = await ingest(mailbox);

        expect(summary).toEqual({
            fetched: 2,
            rejected: 0,
            created: 2,
            skipped: 0,
            failed: 1,
        });
        expect(mailbox.uids(FAILED)).toEqual([41]);
        expect(mailbox.uids(PROCESSED)).toEqual([42]);
    });

    /**
     * AUTHORISE FIRST, PARSE SECOND.
     *
     * The message's bytes throw if anything reads them, so the rejection completing at all is the
     * assertion: no MIME was parsed, and no attachment was base64-decoded into this process, for a
     * sender nobody vouched for. Never relax this into "the summary says rejected" — that passes
     * just as happily with the parse back in front of the check, which is the bug this pins.
     */
    it("rejects an envelope sender who is not on the allowlist without reading the message at all", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, unreadable(61, "stranger@example.net"));

        const summary = await ingest(mailbox);

        expect(summary).toEqual({
            fetched: 1,
            rejected: 1,
            created: 0,
            skipped: 0,
            failed: 0,
        });
        expect(await documents()).toHaveLength(0);
        expect(content.uploaded).toEqual([]);
        expect(mailbox.uids(REJECTED)).toEqual([61]);
    });

    it("rejects a mail with no envelope sender at all", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, unreadable(62, ""));

        const summary = await ingest(mailbox);

        expect(summary.rejected).toBe(1);
        expect(mailbox.uids(REJECTED)).toEqual([62]);
    });

    /** Both must be allowed: forging a `From:` header behind an allowed envelope is one line of SMTP. */
    it("rejects an allowed envelope whose From header is somebody else", async () => {
        const mailbox = new FakeMailbox();
        // plain-text.eml's header says anna.beispiel@example.com; the envelope claims the allowed one.
        mailbox.put(INCOMING, fetched(63, "plain-text.eml", "user@example.com"));

        const summary = await ingest(mailbox);

        expect(summary).toEqual({
            fetched: 1,
            rejected: 1,
            created: 0,
            skipped: 0,
            failed: 0,
        });
        expect(await documents()).toHaveLength(0);
        expect(mailbox.uids(REJECTED)).toEqual([63]);
    });

    it("reads a born-digital PDF's text layer into the Document on arrival", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, withPdf(71, "born-digital-invoice.pdf"));

        const summary = await ingest(mailbox);

        expect(summary.created).toBe(1);
        const [document] = await documents();
        // The Receptionist is woken by a Document that is already classifiable.
        expect(document?.data.extractedText).toContain("Rechnungsnummer: 2026-04711");
        expect(document?.data.extractedText).toContain("106,60 EUR");
    });

    it("leaves a scanned PDF's Document without text, and does not call that a failure", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, withPdf(72, "scanned-no-text.pdf"));

        const summary = await ingest(mailbox);

        expect(summary).toEqual({
            fetched: 1,
            rejected: 0,
            created: 1,
            skipped: 0,
            failed: 0,
        });
        const [document] = await documents();
        expect(document?.data.extractedText).toBe("");
        expect(mailbox.uids(PROCESSED)).toEqual([72]);
    });

    /** The covering note is the most useful sentence in the message. Nothing may overwrite it. */
    it("keeps the mail body AND appends what the PDF says, under a heading naming the file", async () => {
        // This test previously asserted `not.toContain("Rechnungsnummer")` — that the invoice's own
        // text must be absent whenever the mail had a covering note. That was the specification it
        // was written to, and the specification was wrong: almost every forward has a covering note,
        // so the invoice was never read in practice. Measured on a real forwarded builder's invoice,
        // the Document arrived with "Begin forwarded message: From: Andreas Herescu…" and not one
        // figure from the invoice, which is the whole purpose of the exercise.
        const mailbox = new FakeMailbox();
        mailbox.put(
            INCOMING,
            withPdf(73, "born-digital-invoice.pdf", {
                body: "Die Zahnarztrechnung, ist schon bezahlt.",
            }),
        );

        await ingest(mailbox);

        const [document] = await documents();
        const text = String(document?.data.extractedText ?? "");
        // The forwarder's words first, because that is what a human opening the mail reads first.
        expect(text).toContain("Die Zahnarztrechnung, ist schon bezahlt.");
        // Then the document itself.
        expect(text).toContain("Rechnungsnummer");
        // Named, because a message with three PDFs would otherwise leave the model guessing which
        // text belonged to which file.
        expect(text).toContain("--- born-digital-invoice.pdf ---");
        expect(text.indexOf("Die Zahnarztrechnung")).toBeLessThan(text.indexOf("Rechnungsnummer"));
    });

    it("appends the PDF's text with no leading blank when the mail has no body at all", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, withPdf(75, "born-digital-invoice.pdf", { body: "" }));

        await ingest(mailbox);

        const [document] = await documents();
        const text = String(document?.data.extractedText ?? "");
        expect(text.startsWith("--- born-digital-invoice.pdf ---")).toBe(true);
        expect(text).toContain("Rechnungsnummer");
    });

    it("creates the Document anyway when the text-layer reader throws", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, withPdf(74, "born-digital-invoice.pdf"));
        reader.throws = true;

        const summary = await ingest(mailbox);

        expect(summary).toEqual({
            fetched: 1,
            rejected: 0,
            created: 1,
            skipped: 0,
            failed: 0,
        });
        expect(await documents()).toHaveLength(1);
        expect(mailbox.uids(PROCESSED)).toEqual([74]);
    });

    it("does nothing, and touches no mailbox, when the Operation Thing is switched off", async () => {
        await seedOperation(false);
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, fetched(81, "forward-one-pdf.eml"));

        const summary = await ingest(mailbox);

        expect(summary).toEqual({
            fetched: 0,
            rejected: 0,
            created: 0,
            skipped: 0,
            failed: 0,
        });
        expect(mailbox.calls).toEqual([]);
        expect(mailbox.uids(INCOMING)).toEqual([81]);
        expect(await documents()).toHaveLength(0);
    });

    it("polls as usual when the Operation Thing is switched on", async () => {
        await seedOperation(true);
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, fetched(82, "forward-one-pdf.eml"));

        const summary = await ingest(mailbox);

        expect(summary.created).toBe(1);
        expect(mailbox.uids(PROCESSED)).toEqual([82]);
    });

    /**
     * THE DECISION, PINNED. **An absent Operation Thing means the letterbox runs.**
     *
     * The inbox route reads an absent Thing as *off*, because it is a check that grants access. This
     * one grants nothing — the gate here is the sender allowlist, which comes from configuration and
     * cannot be opened by a Thing that is missing — so a catalogue that has not been seeded yet is a
     * statement about the catalogue, not about whether the household wants its post.
     */
    it("polls when there is no Operation Thing at all", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, fetched(83, "forward-one-pdf.eml"));

        const summary = await ingest(mailbox);

        expect(summary.created).toBe(1);
        expect(mailbox.uids(PROCESSED)).toEqual([83]);
    });

    /** Same reason, plus one: a briefly unreadable catalogue must not hold the User's post back. */
    it("polls when the Operation catalogue cannot be read at all", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, fetched(84, "forward-one-pdf.eml"));
        const query = things.search.bind(things);
        things.search = (async (spec, constraint, limit) => {
            if (spec.model === "Operation_DM") throw new Error("the store is down");
            return query(spec, constraint, limit);
        }) as typeof things.search;

        const summary = await ingest(mailbox);

        expect(summary.created).toBe(1);
        expect(mailbox.uids(PROCESSED)).toEqual([84]);
    });

    /**
     * DEFECT 1, PINNED. **A move that fails may not turn a success into a failure.**
     *
     * Every Document landed. One transient IMAP error on the last statement, and the old code filed
     * the message in `assistant/failed` — "tried, threw, gave up", the folder the architecture
     * reserves for a human's attention — and counted it `failed`. Nothing about that is
     * self-healing: the message is out of `incoming`, so the poll that actually succeeded sits in a
     * failure inbox for ever.
     *
     * What must happen instead is nothing. The message keeps its verdict, stays where it is, and
     * the next poll finishes the job — which is what the second half of this test asserts.
     */
    it("leaves a fully ingested mail in incoming when the move to processed fails, and calls it a success", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, fetched(91, "forward-one-pdf.eml"));
        mailbox.refuseNextMove = true;

        const summary = await ingest(mailbox);

        expect(summary).toEqual({
            fetched: 1,
            rejected: 0,
            created: 1,
            skipped: 0,
            failed: 0,
        });
        expect(await documents()).toHaveLength(1);
        expect(mailbox.uids(FAILED)).toEqual([]);
        expect(mailbox.uids(PROCESSED)).toEqual([]);
        expect(mailbox.uids(INCOMING)).toEqual([91]);
        // Exactly one move was attempted: no second, compensating move to anywhere else.
        expect(mailbox.calls.filter((call) => call.startsWith("move:"))).toEqual([
            `move:91:${INCOMING}->${PROCESSED}`,
        ]);

        // Self-healing: the ExternalRef query skips the Document, and the move happens now.
        const second = await ingest(mailbox);
        expect(second).toEqual({
            fetched: 1,
            rejected: 0,
            created: 0,
            skipped: 1,
            failed: 0,
        });
        expect(await documents()).toHaveLength(1);
        expect(mailbox.uids(PROCESSED)).toEqual([91]);
    });

    /**
     * DEFECT 2, PINNED. **"Not for us" and "we broke" may not share a folder, or a counter.**
     *
     * A stranger's mail whose move to `rejected` hiccupped used to end in `assistant/failed` — the
     * exact collapse the three-folder design exists to prevent — and to be counted in BOTH
     * `summary.rejected` and `summary.failed`, so the poll log said two things happened to one
     * message.
     */
    it("leaves a rejected mail in incoming when the move to rejected fails, and counts it once", async () => {
        const mailbox = new FakeMailbox();
        // plain-text.eml is from anna.beispiel@example.com; only user@example.com is allowed.
        mailbox.put(INCOMING, fetched(92, "plain-text.eml"));
        mailbox.refuseNextMove = true;

        const summary = await ingest(mailbox);

        expect(summary).toEqual({
            fetched: 1,
            rejected: 1,
            created: 0,
            skipped: 0,
            failed: 0,
        });
        expect(mailbox.uids(FAILED)).toEqual([]);
        expect(mailbox.uids(REJECTED)).toEqual([]);
        expect(mailbox.uids(INCOMING)).toEqual([92]);
        expect(mailbox.calls.filter((call) => call.startsWith("move:"))).toEqual([
            `move:92:${INCOMING}->${REJECTED}`,
        ]);

        const second = await ingest(mailbox);
        expect(second).toEqual({
            fetched: 1,
            rejected: 1,
            created: 0,
            skipped: 0,
            failed: 0,
        });
        expect(mailbox.uids(REJECTED)).toEqual([92]);
    });

    /** The third path, for completeness: a failed mail whose move also fails is counted once, too. */
    it("leaves a failed mail in incoming when the move to failed fails, and counts it once", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, fetched(93, "forward-two-pdfs.eml"));
        content.refuse = "zweite.pdf";
        mailbox.refuseNextMove = true;

        const summary = await ingest(mailbox);

        expect(summary).toEqual({
            fetched: 1,
            rejected: 0,
            created: 1,
            skipped: 0,
            failed: 1,
        });
        expect(mailbox.uids(INCOMING)).toEqual([93]);
        expect(mailbox.calls.filter((call) => call.startsWith("move:"))).toEqual([
            `move:93:${INCOMING}->${FAILED}`,
        ]);
    });

    /** One message's move failing says nothing about the next one. */
    it("carries on with the next message when one of them cannot be moved", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, fetched(94, "forward-one-pdf.eml"), fetched(95, "forward-two-pdfs.eml"));
        mailbox.refuseNextMove = true;

        const summary = await ingest(mailbox);

        expect(summary).toEqual({
            fetched: 2,
            rejected: 0,
            created: 3,
            skipped: 0,
            failed: 0,
        });
        expect(mailbox.uids(INCOMING)).toEqual([94]);
        expect(mailbox.uids(PROCESSED)).toEqual([95]);
    });

    /**
     * DEFECT 4, PINNED. **A Document's text is bounded, and says when it was bounded.**
     *
     * `Document_DM.ExtractedText` has no `maxLength`, so the limit is paid by the Receptionist, on
     * the very next Turn, per token. The note matters as much as the cap: a text that simply stops
     * is read as a document that ends there.
     */
    it("caps a very long mail body and says so in the stored text", async () => {
        const body = "Sehr geehrte Damen und Herren. ".repeat(2_000);
        expect(body.length).toBeGreaterThan(MAX_EXTRACTED_TEXT_LENGTH);
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, withPdf(96, "scanned-no-text.pdf", { body }));

        const summary = await ingest(mailbox);

        expect(summary.created).toBe(1);
        const [document] = await documents();
        const text = document?.data.extractedText ?? "";
        expect(text.length).toBeLessThan(MAX_EXTRACTED_TEXT_LENGTH + 200);
        expect(text).toContain(`truncated at ${MAX_EXTRACTED_TEXT_LENGTH} characters`);
        expect(text.startsWith("Sehr geehrte Damen und Herren.")).toBe(true);
    });

    it("stores an ordinary invoice's text whole, with no note", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, withPdf(97, "born-digital-invoice.pdf"));

        await ingest(mailbox);

        const [document] = await documents();
        expect(document?.data.extractedText).not.toContain("truncated");
        expect((document?.data.extractedText ?? "").length).toBeLessThanOrEqual(MAX_EXTRACTED_TEXT_LENGTH);
    });

    /**
     * ONE POLL, ONE CONNECTION.
     *
     * The poll below does the folder check, a fetch, one oversized filing and three ordinary moves —
     * six operations that used to be six logins, and at `maxPerPoll: 20` would be twenty-two a
     * minute against a provider that throttles reconnects, every one of those handshakes inside the
     * scan loop. Counting the sessions is the only way to assert it: every other observable
     * behaviour of the poll is identical either way, which is exactly why it went unnoticed.
     */
    it("opens exactly one connection for the whole poll, however much it does", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(
            INCOMING,
            fetched(101, "forward-one-pdf.eml"),
            fetched(102, "plain-text.eml"),
            fetched(103, "forward-two-pdfs.eml"),
            unreadable(104, "user@example.com"),
        );
        mailbox.tooLarge.set(104, 80 * 1024 * 1024);

        await ingest(mailbox);

        expect(mailbox.sessionsOpened).toBe(1);
        // And everything happened inside it: the connection is opened first and closed last.
        expect(mailbox.calls.at(0)).toBe("session:open");
        expect(mailbox.calls.at(-1)).toBe("session:close");
        expect(mailbox.calls.filter((call) => call.startsWith("move:"))).toHaveLength(4);
    });

    /**
     * A MESSAGE NOBODY CAN DOWNLOAD MUST STILL LEAVE THE INCOMING FOLDER.
     *
     * `fetchBatch` declines it on the server's own size, so not one byte of it is read — the message
     * here throws if anything touches its bytes, which is how that is asserted rather than assumed.
     * Left where it is, it would be declined again every minute for ever, and since a poll takes at
     * most `maxPerPoll` candidates, a few of them at the head of the folder would starve the real
     * invoices behind them. It belongs in `failed`, which a human reads.
     */
    it("moves a mail too large to download to failed, counts it, and never sees it again", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, unreadable(111, "user@example.com"), fetched(112, "forward-one-pdf.eml"));
        mailbox.tooLarge.set(111, 80 * 1024 * 1024);

        const summary = await ingest(mailbox);

        // `fetched` counts what was read, and the oversized message never was.
        expect(summary).toEqual({
            fetched: 1,
            rejected: 0,
            created: 1,
            skipped: 0,
            failed: 1,
        });
        expect(mailbox.uids(FAILED)).toEqual([111]);
        expect(mailbox.uids(PROCESSED)).toEqual([112]);
        expect(mailbox.uids(INCOMING)).toEqual([]);

        const second = await ingest(mailbox);
        expect(second).toEqual({
            fetched: 0,
            rejected: 0,
            created: 0,
            skipped: 0,
            failed: 0,
        });
        expect(mailbox.uids(FAILED)).toEqual([111]);
    });

    /** A move that will not go through leaves it where it is — self-healing, like every other move. */
    it("leaves an oversized mail in incoming when the move to failed fails", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, unreadable(113, "user@example.com"));
        mailbox.tooLarge.set(113, 80 * 1024 * 1024);
        mailbox.refuseNextMove = true;

        const summary = await ingest(mailbox);

        expect(summary.failed).toBe(1);
        expect(mailbox.uids(INCOMING)).toEqual([113]);

        const second = await ingest(mailbox);
        expect(second.failed).toBe(1);
        expect(mailbox.uids(FAILED)).toEqual([113]);
    });

    /**
     * A POLL THAT STOPPED ON ITS BUDGET SAYS SO — and nothing else.
     *
     * It is a normal, self-correcting event: what was not fetched is still in `incoming` and the
     * next poll continues with it, so no counter moves and nothing is filed anywhere. But silence
     * here is baffling to anybody watching a backlog drain more slowly than `maxPerPoll` would
     * explain, so it is one info line per poll — not a warning, and never per message.
     */
    it("logs one line when the poll spent its byte budget, and none when it did not", async () => {
        const infos = vi.spyOn(log, "info").mockImplementation(() => {});
        const said = (): number =>
            infos.mock.calls.filter(
                ([message]) =>
                    message === "the letterbox poll spent its byte budget; the rest waits for the next poll",
            ).length;

        const quiet = new FakeMailbox();
        quiet.put(INCOMING, fetched(121, "forward-one-pdf.eml"));
        expect(await ingest(quiet)).toEqual({
            fetched: 1,
            rejected: 0,
            created: 1,
            skipped: 0,
            failed: 0,
        });
        expect(said()).toBe(0);

        const busy = new FakeMailbox();
        busy.put(INCOMING, fetched(122, "forward-two-pdfs.eml"));
        busy.budgetExhausted = true;
        // Nothing about the summary changes: the budget is about pace, not about outcomes.
        expect(await ingest(busy)).toEqual({
            fetched: 1,
            rejected: 0,
            created: 2,
            skipped: 0,
            failed: 0,
        });
        expect(said()).toBe(1);
        expect(busy.uids(PROCESSED)).toEqual([122]);

        infos.mockRestore();
    });

    /**
     * A MESSAGE WITH NO `Message-ID` IS IDENTIFIED BY THE MAILBOX IT WAS FOUND IN.
     *
     * Without the origin the ref falls back to `<uid.N@local>`, which is unique to nothing. The ref
     * must also be *stable*: it is computed from the UID, the folder, the host and the generation,
     * none of which change between polls, so the same message polled twice is skipped rather than
     * duplicated.
     */
    it("derives a Message-ID-less mail's ref from its mailbox, and gets the same one twice", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, noMessageId(131, "Bestellbestaetigung"));
        mailbox.swallowNextMove = true;

        const first = await ingest(mailbox);

        expect(first.created).toBe(1);
        const [document] = await documents();
        expect(document?.data.externalRef).toBe(`<uid.131.v1.${INCOMING}@imap.example.com>#0`);
        expect(document?.data.externalRef).not.toContain("@local");

        // The move was swallowed, so the very same message is polled again.
        expect(mailbox.uids(INCOMING)).toEqual([131]);
        const second = await ingest(mailbox);

        expect(second).toEqual({
            fetched: 1,
            rejected: 0,
            created: 0,
            skipped: 1,
            failed: 0,
        });
        expect(await documents()).toHaveLength(1);
    });

    /**
     * THE SILENTLY DROPPED INVOICE, PINNED.
     *
     * An IMAP UID is unique within one `(mailbox, UIDVALIDITY)` generation and nowhere else. Delete
     * and recreate the `assistant` label — a thing people do to Gmail labels — and the server hands
     * out UID 1 again. Without the generation in the ref, this second, completely different mail
     * computes the ref the first one already holds, the `ExternalRef` query says "already landed",
     * and the invoice is skipped and filed in `processed` looking like a success.
     */
    it("does not confuse two mails that share a UID across a recreated label", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, noMessageId(5, "Die erste Rechnung"));

        await ingest(mailbox);

        // The label is dropped and recreated; UIDs start over and a different mail is now UID 5.
        mailbox.uidValidity = "2";
        mailbox.put(INCOMING, noMessageId(5, "Die zweite Rechnung"));

        const second = await ingest(mailbox);

        expect(second).toEqual({
            fetched: 1,
            rejected: 0,
            created: 1,
            skipped: 0,
            failed: 0,
        });
        const created = await documents();
        expect(created.map((document) => document.data.externalRef).sort()).toEqual([
            `<uid.5.v1.${INCOMING}@imap.example.com>#0`,
            `<uid.5.v2.${INCOMING}@imap.example.com>#0`,
        ]);
        expect(created.map((document) => document.data.title).sort()).toEqual([
            "Die erste Rechnung",
            "Die zweite Rechnung",
        ]);
    });

    /**
     * THE OTHER CAP. **Arrival bounds the pages it decodes, not only the characters it stores.**
     *
     * A five-hundred-page prospectus decoded in the scan loop holds up every other scan and outlives
     * the heartbeat, and `MAX_EXTRACTED_TEXT_LENGTH` cannot prevent it: that cap applies to the text
     * *after* the decode has already been paid for. Both caps are needed and neither replaces the
     * other — and the note is what stops a Document that stops at page twenty from reading like a
     * document that ends there.
     */
    it("decodes at most ARRIVAL_MAX_PAGES of a long PDF, and says so in the stored text", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, withPdfBytes(141, "prospekt.pdf", manyPagePdf(25)));

        const summary = await ingest(mailbox);

        expect(summary.created).toBe(1);
        expect(reader.maxPages).toBe(ARRIVAL_MAX_PAGES);
        const text = (await documents())[0]?.data.extractedText ?? "";
        expect(text).toContain(`Seite ${ARRIVAL_MAX_PAGES} von 25`);
        expect(text).not.toContain("Seite 21 von 25");
        expect(text).toContain(`Only the first ${ARRIVAL_MAX_PAGES} of 25 pages were read`);
    });

    /** The ordinary case says nothing, because there is nothing to say. */
    it("adds no page note to a PDF it read to the end", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, withPdfBytes(142, "kurz.pdf", manyPagePdf(2)));

        await ingest(mailbox);

        const text = (await documents())[0]?.data.extractedText ?? "";
        expect(text).toContain("Seite 2 von 2");
        expect(text).not.toContain("pages were read");
    });

    /**
     * DEFECT 3, PINNED — half of it. **A wholesale failure leaves as an exception.**
     *
     * A failure before the first message — cannot connect, cannot authenticate, cannot list the
     * folders — is not something a summary can describe: nothing was attempted, so every counter
     * is zero, which is indistinguishable from an empty letterbox. Swallowing it here logged one
     * ERROR a minute for ever and left the Watcher's once-per-outage suppression unreachable. It
     * is the ONLY thing this function raises; everything per-message stays in the summary, which
     * the tests above assert at length.
     */
    it("throws MailboxUnreachable when the mailbox itself cannot be read", async () => {
        const mailbox = new FakeMailbox();
        mailbox.failFetch = "ECONNREFUSED";

        await expect(ingest(mailbox)).rejects.toBeInstanceOf(MailboxUnreachable);
    });

    it("throws MailboxUnreachable when the folders cannot be listed or created", async () => {
        const mailbox = new FakeMailbox();
        mailbox.failEnsureFolders = "AUTHENTICATIONFAILED";

        await expect(ingest(mailbox)).rejects.toThrow(/AUTHENTICATIONFAILED/);
    });

    /** The connection itself, which is now the first thing a poll needs and the first thing to fail. */
    it("throws MailboxUnreachable when the connection cannot be opened at all", async () => {
        const mailbox = new FakeMailbox();
        mailbox.failConnect = "ETIMEDOUT";

        await expect(ingest(mailbox)).rejects.toBeInstanceOf(MailboxUnreachable);
        await expect(ingest(mailbox)).rejects.toThrow(/ETIMEDOUT/);
    });
});

/**
 * DEFECT 3, PINNED — the other half. **The Watcher says it once, not once a minute.**
 *
 * This lives here rather than beside the other Watcher tests because it is a claim about the seam
 * between the two files: the ingest raises a wholesale failure precisely so that the one piece of
 * state that can make it bearable to read — "have I already said this?" — can live in the Watcher,
 * where it survives across polls. Assert them apart and the seam is what nobody tests.
 */
describe("the Watcher's letterbox suppression", () => {
    function watcherOver(poll: () => Promise<number>): Watcher {
        return new Watcher({
            things,
            driver: { advance: async () => {} } as unknown as LoopDriver,
            maxBirthsPerHour: 10,
            scheduleTimezone: "Europe/Berlin",
            birth: async () => "",
            pollMailbox: poll,
            // Zero, so every scan polls: the interval is not what this test is about.
            mailPollIntervalMs: 0,
        });
    }

    it("logs one error for an outage that spans many polls, and one line when it recovers", async () => {
        await seedOperation(true);
        const errors = vi.spyOn(log, "error").mockImplementation(() => {});
        const infos = vi.spyOn(log, "info").mockImplementation(() => {});

        let reachable = false;
        const watcher = watcherOver(async () => {
            if (!reachable) throw new MailboxUnreachable(new Error("ECONNREFUSED"));
            return 0;
        });

        for (let poll = 0; poll < 5; poll++) await watcher.scan();

        const complaints = errors.mock.calls.filter(([message]) => message === "could not read the letterbox");
        expect(complaints).toHaveLength(1);

        reachable = true;
        await watcher.scan();
        await watcher.scan();

        const recoveries = infos.mock.calls.filter(([message]) => message === "the letterbox is reachable again");
        expect(recoveries).toHaveLength(1);

        errors.mockRestore();
        infos.mockRestore();
    });
});
