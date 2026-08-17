import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { A12Client } from "../../src/a12/client.js";
import type { UploadedAttachment } from "../../src/a12/content.js";
import { SPECS, ThingRepository } from "../../src/a12/things.js";
import type { FetchedMessage } from "../../src/connectors/email.js";
import type { MailConfig } from "../../src/config.js";
import type { DocumentThing, Stored } from "../../src/domain/types.js";
import { isAllowedSender, runMailIngest } from "../../src/watcher/mail.js";
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
const reader = vi.hoisted(() => ({ throws: false }));
vi.mock("../../src/readers/textLayer.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/readers/textLayer.js")>();
    return {
        ...actual,
        readTextLayer: (bytes: Buffer, minChars?: number) => {
            if (reader.throws) throw new Error("pdfjs fell over");
            return actual.readTextLayer(bytes, minChars);
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
    return { uid, raw, internalDate: INTERNAL_DATE, envelopeFrom: envelopeFrom ?? headerFrom(raw) };
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

/** A forward with one PDF attached, built here because the PDF is what the test is about. */
function withPdf(uid: number, pdf: string, options: { body?: string; messageId?: string } = {}): FetchedMessage {
    const bytes = readFileSync(`${PDF_FIXTURES}${pdf}`).toString("base64");
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
    return { uid, raw, internalDate: INTERNAL_DATE, envelopeFrom: "user@example.com" };
}

/**
 * A mailbox with folders and no protocol.
 *
 * It really moves messages between folders and really refuses a folder it has never been told
 * about, which is what makes "a missing folder is created rather than throwing" a claim about the
 * ingest instead of a claim about the fake. It records every call so a disabled ingest can be shown
 * to have touched nothing at all.
 */
class FakeMailbox {
    readonly folders = new Map<string, FetchedMessage[]>();
    readonly calls: string[] = [];
    /**
     * Swallow the next `move`, leaving the message where it was. That is the crash between
     * `ADD_DOCUMENT` and `MOVE` — the one window the move-last ordering exists to survive.
     */
    swallowNextMove = false;

    constructor(existingFolders: readonly string[] = [INCOMING]) {
        for (const folder of existingFolders) this.folders.set(folder, []);
    }

    put(folder: string, ...messages: FetchedMessage[]): void {
        this.folders.set(folder, [...(this.folders.get(folder) ?? []), ...messages]);
    }

    uids(folder: string): number[] {
        return (this.folders.get(folder) ?? []).map((message) => message.uid);
    }

    async ensureFolders(folders: readonly string[]): Promise<void> {
        this.calls.push(`ensureFolders:${folders.join(",")}`);
        for (const folder of folders) if (!this.folders.has(folder)) this.folders.set(folder, []);
    }

    async fetch(folder: string, max: number): Promise<FetchedMessage[]> {
        this.calls.push(`fetch:${folder}:${max}`);
        const rows = this.folders.get(folder);
        if (!rows) throw new Error(`No folder ${folder}`);
        return rows.slice(0, max);
    }

    async move(uid: number, fromFolder: string, toFolder: string): Promise<void> {
        this.calls.push(`move:${uid}:${fromFolder}->${toFolder}`);
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

/** A Content Store that keeps the bytes in a list and can be told to refuse one file. */
class FakeContentStore {
    readonly uploaded: Array<{ filename: string; mimeType: string; bytes: number }> = [];
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
    it("does nothing at all, and touches no mailbox, when the host is empty", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, fetched(1, "forward-one-pdf.eml"));

        const summary = await ingest(mailbox, mailConfig({ host: "" }));

        expect(summary).toEqual({ fetched: 0, rejected: 0, created: 0, skipped: 0, failed: 0 });
        expect(mailbox.calls).toEqual([]);
        expect(await documents()).toHaveLength(0);
    });

    it("turns a mail from an allowed sender into a Document and moves it to processed", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, fetched(7, "forward-one-pdf.eml"));

        const summary = await ingest(mailbox);

        expect(summary).toEqual({ fetched: 1, rejected: 0, created: 1, skipped: 0, failed: 0 });

        const [document] = await documents();
        expect(document?.data.source).toBe("email");
        expect(document?.data.externalRef).toBe("<fwd-one@example.com>#1");
        expect(document?.data.title).toBe("Fwd: Zahnarztrechnung");
        expect(document?.data.mediaType).toBe("application/pdf");
        expect(document?.data.extractedText).toContain("Zahnarztrechnung");
        expect(document?.data.receivedAt).toBe("2026-01-13T17:02:11.000Z");

        expect(mailbox.uids(INCOMING)).toEqual([]);
        expect(mailbox.uids(PROCESSED)).toEqual([7]);
    });

    it("puts the uploaded attachment on the Document's attachment group", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, fetched(7, "forward-one-pdf.eml"));

        await ingest(mailbox);

        expect(content.uploaded).toEqual([
            { filename: "rechnung.pdf", mimeType: "application/pdf", bytes: expect.any(Number) },
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

        expect(summary).toEqual({ fetched: 1, rejected: 1, created: 0, skipped: 0, failed: 0 });
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
        expect(created.map((document) => document.data.title)).toEqual([
            "Fwd: zwei Rechnungen",
            "Fwd: zwei Rechnungen",
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

        expect(summary).toEqual({ fetched: 1, rejected: 0, created: 1, skipped: 0, failed: 1 });
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

        expect(second).toEqual({ fetched: 1, rejected: 0, created: 0, skipped: 1, failed: 0 });
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

        expect(second).toEqual({ fetched: 1, rejected: 0, created: 0, skipped: 2, failed: 0 });
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
        expect(mailbox.calls).toContain(`fetch:${INCOMING}:2`);
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

        expect(summary).toEqual({ fetched: 2, rejected: 0, created: 2, skipped: 0, failed: 1 });
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

        expect(summary).toEqual({ fetched: 1, rejected: 1, created: 0, skipped: 0, failed: 0 });
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

        expect(summary).toEqual({ fetched: 1, rejected: 1, created: 0, skipped: 0, failed: 0 });
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

        expect(summary).toEqual({ fetched: 1, rejected: 0, created: 1, skipped: 0, failed: 0 });
        const [document] = await documents();
        expect(document?.data.extractedText).toBe("");
        expect(mailbox.uids(PROCESSED)).toEqual([72]);
    });

    /** The covering note is the most useful sentence in the message. Nothing may overwrite it. */
    it("keeps the mail body when the message has both body text and a readable PDF", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(
            INCOMING,
            withPdf(73, "born-digital-invoice.pdf", { body: "Die Zahnarztrechnung, ist schon bezahlt." }),
        );

        await ingest(mailbox);

        const [document] = await documents();
        expect(document?.data.extractedText).toContain("Die Zahnarztrechnung, ist schon bezahlt.");
        expect(document?.data.extractedText).not.toContain("Rechnungsnummer");
    });

    it("creates the Document anyway when the text-layer reader throws", async () => {
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, withPdf(74, "born-digital-invoice.pdf"));
        reader.throws = true;

        const summary = await ingest(mailbox);

        expect(summary).toEqual({ fetched: 1, rejected: 0, created: 1, skipped: 0, failed: 0 });
        expect(await documents()).toHaveLength(1);
        expect(mailbox.uids(PROCESSED)).toEqual([74]);
    });

    it("does nothing, and touches no mailbox, when the Operation Thing is switched off", async () => {
        await seedOperation(false);
        const mailbox = new FakeMailbox();
        mailbox.put(INCOMING, fetched(81, "forward-one-pdf.eml"));

        const summary = await ingest(mailbox);

        expect(summary).toEqual({ fetched: 0, rejected: 0, created: 0, skipped: 0, failed: 0 });
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

    it("returns a summary rather than throwing when the mailbox itself is unreachable", async () => {
        const mailbox = new FakeMailbox();
        mailbox.fetch = async () => {
            throw new Error("ECONNREFUSED");
        };

        await expect(ingest(mailbox)).resolves.toEqual({
            fetched: 0,
            rejected: 0,
            created: 0,
            skipped: 0,
            failed: 0,
        });
    });
});
