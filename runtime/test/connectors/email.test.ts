import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { envelopeAddress, parseMessage, planFetch, type MessageMetadata } from "../../src/connectors/email.js";

/**
 * The Email Connector's parsing half, against real `.eml` files.
 *
 * The fixtures are the point of this file. MIME is not a format anybody reasons about correctly in
 * the abstract — every rule in the architecture ("one Document per attachment", "the body is
 * repeated", "inline signature images are not invoices") is a claim about bytes, so each one is
 * pinned to bytes on disk rather than to a hand-built object graph. The IMAP half is not tested
 * here: it needs a server, and the whole reason the Connector is split in two is that this half
 * does not.
 */

const FIXTURES = fileURLToPath(new URL("../fixtures/mail/", import.meta.url));

/** Bigger than any fixture attachment, so the cap is out of the way unless a test wants it. */
const NO_CAP = 25 * 1024 * 1024;

/** Whatever the server said, for the one case where the message itself has no usable date. */
const INTERNAL_DATE = new Date("2026-06-01T10:00:00.000Z");

function load(name: string): Buffer {
    return readFileSync(`${FIXTURES}${name}`);
}

describe("parseMessage", () => {
    it("turns a plain-text mail into a single body-only Document", async () => {
        const message = await parseMessage(load("plain-text.eml"), 41, INTERNAL_DATE, NO_CAP);

        expect(message.uid).toBe(41);
        expect(message.from).toBe("anna.beispiel@example.com");
        expect(message.subject).toBe("Stromrechnung Januar");
        expect(message.documents).toHaveLength(1);

        const [document] = message.documents;
        expect(document?.title).toBe("Stromrechnung Januar");
        expect(document?.externalRef).toBe("<plain-001@example.com>#0");
        expect(document?.attachment).toBeUndefined();
        expect(document?.extractedText).toContain("84,20 EUR");
        expect(document?.receivedAt).toBe("2026-01-12T08:14:00.000Z");
    });

    it("carries one attachment on the one Document a single-PDF forward becomes", async () => {
        const message = await parseMessage(load("forward-one-pdf.eml"), 42, INTERNAL_DATE, NO_CAP);

        expect(message.documents).toHaveLength(1);
        const [document] = message.documents;
        expect(document?.externalRef).toBe("<fwd-one@example.com>#1");
        expect(document?.attachment?.filename).toBe("rechnung.pdf");
        expect(document?.attachment?.mimeType).toBe("application/pdf");
        expect(document?.attachment?.size).toBeGreaterThan(0);
        expect(document?.attachment?.size).toBe(document?.attachment?.bytes.length);
        expect(document?.attachment?.bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
        // The forward note is context for the attachment, not a Document of its own.
        expect(document?.extractedText).toContain("Zahnarztrechnung fuer Anna");
    });

    it("splits two attachments into two Documents that share one body", async () => {
        const message = await parseMessage(load("forward-two-pdfs.eml"), 43, INTERNAL_DATE, NO_CAP);

        expect(message.documents).toHaveLength(2);
        const [first, second] = message.documents;

        expect(first?.externalRef).toBe("<fwd-two@example.com>#1");
        expect(second?.externalRef).toBe("<fwd-two@example.com>#2");
        expect(first?.externalRef).not.toBe(second?.externalRef);

        expect(first?.attachment?.filename).toBe("erste.pdf");
        expect(second?.attachment?.filename).toBe("zweite.pdf");

        // Deliberate: the same note explains both invoices.
        expect(first?.extractedText).toBe(second?.extractedText);
        expect(first?.extractedText).toContain("Beide Rechnungen im Anhang.");
    });

    it("reduces an HTML-only mail to prose", async () => {
        const message = await parseMessage(load("html-only.eml"), 44, INTERNAL_DATE, NO_CAP);

        const [document] = message.documents;
        expect(document?.extractedText).toContain("19,99 EUR");
        expect(document?.extractedText).not.toContain("<");
        expect(document?.extractedText).not.toContain("body");
    });

    it("skips an inline signature image", async () => {
        const message = await parseMessage(load("inline-signature.eml"), 45, INTERNAL_DATE, NO_CAP);

        expect(message.documents).toHaveLength(1);
        const [document] = message.documents;
        expect(document?.attachment).toBeUndefined();
        expect(document?.externalRef).toBe("<sig-inline@example.org>#0");
        expect(document?.extractedText).toContain("Rueckmeldung");
    });

    it("decodes an encoded-word subject", async () => {
        const message = await parseMessage(load("encoded-subject.eml"), 46, INTERNAL_DATE, NO_CAP);

        expect(message.subject).toBe("Rechnung für März");
        expect(message.documents[0]?.title).toBe("Rechnung für März");
    });

    it("skips an oversized attachment and says so in the text", async () => {
        const message = await parseMessage(load("oversized-attachment.eml"), 48, INTERNAL_DATE, 1024);

        expect(message.documents).toHaveLength(1);
        const [document] = message.documents;
        expect(document?.attachment).toBeUndefined();
        // Not `#0`: `#0` is reserved for a message that had no attachment at all. See the
        // part-numbering suite below for why sharing one ref between those two cases loses mail.
        expect(document?.externalRef).toBe("<oversized@example.net>#0.skipped");
        expect(document?.extractedText).toContain("archiv-2025.pdf");
        expect(document?.extractedText).toMatch(/too large|4096/);
        expect(document?.extractedText).toContain("Das komplette Archiv im Anhang.");
    });

    it("falls back to the server's date and to a placeholder title", async () => {
        const raw = Buffer.from(
            ["From: nobody@example.com", "Message-ID: <bare@example.com>", "", "kein Betreff", ""].join(
                "\r\n",
            ),
        );
        const message = await parseMessage(raw, 49, INTERNAL_DATE, NO_CAP);

        expect(message.documents[0]?.receivedAt).toBe(INTERNAL_DATE.toISOString());
        expect(message.documents[0]?.title).toBe("(no subject)");
    });

    it("titles a Document after its attachment when the subject is empty", async () => {
        const message = await parseMessage(load("forward-one-pdf.eml"), 50, INTERNAL_DATE, NO_CAP);
        const withSubject = message.documents[0]?.title;
        expect(withSubject).toBe("Fwd: Zahnarztrechnung");

        const stripped = Buffer.from(
            load("forward-one-pdf.eml").toString("utf8").replace("Subject: Fwd: Zahnarztrechnung", "Subject:  "),
        );
        const untitled = await parseMessage(stripped, 51, INTERNAL_DATE, NO_CAP);
        expect(untitled.documents[0]?.title).toBe("rechnung.pdf");
    });
});

/**
 * The part number is an identity, and the size cap is a setting the User changes.
 *
 * These are the tests that stop the numbering being "simplified" back to the position in the kept
 * array. `MAIL_MAX_ATTACHMENT_BYTES` exists to be raised — the skip is announced in the Document
 * text precisely so somebody raises it and replays the mail — so every ref this function produces
 * has to name the same MIME part at every cap. When it does not, a replay skips the invoice it was
 * performed to collect (its ref is now the one the *other* attachment already holds) and duplicates
 * the one that came through the first time.
 */
describe("parseMessage part numbering across a changed cap", () => {
    /** `big.pdf` (over 1000 bytes) then `small.pdf` — the exact shape of the reproduction. */
    const BIG_AND_SMALL = "big-and-small.eml";

    it("keeps the surviving attachment's ExternalRef when the cap is raised", async () => {
        const tight = await parseMessage(load(BIG_AND_SMALL), 60, INTERNAL_DATE, 1000);
        const loose = await parseMessage(load(BIG_AND_SMALL), 60, INTERNAL_DATE, 100_000);

        // At the tight cap only small.pdf survives, and it is the *second* part.
        expect(tight.documents).toHaveLength(1);
        expect(tight.documents[0]?.attachment?.filename).toBe("small.pdf");
        expect(tight.documents[0]?.externalRef).toBe("<m1@example.com>#2");

        // Raise the cap and big.pdf appears — without moving small.pdf.
        expect(loose.documents).toHaveLength(2);
        expect(loose.documents[0]?.attachment?.filename).toBe("big.pdf");
        expect(loose.documents[0]?.externalRef).toBe("<m1@example.com>#1");
        expect(loose.documents[1]?.attachment?.filename).toBe("small.pdf");

        const refOfSmall = (message: Awaited<ReturnType<typeof parseMessage>>): string | undefined =>
            message.documents.find((document) => document.attachment?.filename === "small.pdf")?.externalRef;
        expect(refOfSmall(loose)).toBe(refOfSmall(tight));
    });

    it("never lets a cap change turn one ExternalRef into another", async () => {
        // The single-attachment case: skipped, then kept. The placeholder Document must not claim
        // the ref the real Document will take once the cap allows it through.
        const skipped = await parseMessage(load("oversized-attachment.eml"), 61, INTERNAL_DATE, 1024);
        const kept = await parseMessage(load("oversized-attachment.eml"), 61, INTERNAL_DATE, NO_CAP);

        expect(skipped.documents[0]?.attachment).toBeUndefined();
        expect(kept.documents[0]?.attachment?.filename).toBe("archiv-2025.pdf");
        expect(skipped.documents[0]?.externalRef).not.toBe(kept.documents[0]?.externalRef);

        // And `#0` still means, and only means, "this message had nothing attached".
        const bodyOnly = await parseMessage(load("plain-text.eml"), 62, INTERNAL_DATE, 1);
        expect(bodyOnly.documents[0]?.externalRef).toBe("<plain-001@example.com>#0");
        expect(skipped.documents[0]?.externalRef).not.toBe("<oversized@example.net>#0");
    });
});

/**
 * The synthesised `Message-ID`, for the senders who do not send one.
 *
 * An IMAP UID is unique within one `(mailbox, UIDVALIDITY)` generation and nowhere else. The old
 * `<uid.N@local>` carried neither, so recreating the `assistant` label — after which the server
 * hands out UID 1 again — gave a brand-new invoice the ref of a long-processed message. The ingest
 * then does exactly what it is built to do: counts it as `skipped` and moves it to `processed`.
 * Nothing anywhere reports the loss, which is what makes this worth a test of its own.
 */
describe("parseMessage without a Message-ID", () => {
    const ORIGIN = { host: "imap.example.com", folder: "assistant", uidValidity: "42" };

    it("names the mailbox generation the UID was issued in", async () => {
        const message = await parseMessage(load("no-message-id.eml"), 47, INTERNAL_DATE, NO_CAP, ORIGIN);

        expect(message.documents[0]?.externalRef).toBe("<uid.47.v42.assistant@imap.example.com>#0");
    });

    it("gives the same UID in a new mailbox generation a different ExternalRef", async () => {
        const before = await parseMessage(load("no-message-id.eml"), 1, INTERNAL_DATE, NO_CAP, ORIGIN);
        // The label was deleted and recreated; the server restarts UIDs at 1 under a new UIDVALIDITY.
        const after = await parseMessage(load("no-message-id.eml"), 1, INTERNAL_DATE, NO_CAP, {
            ...ORIGIN,
            uidValidity: "43",
        });
        const otherFolder = await parseMessage(load("no-message-id.eml"), 1, INTERNAL_DATE, NO_CAP, {
            ...ORIGIN,
            folder: "assistant/failed",
        });

        expect(after.documents[0]?.externalRef).not.toBe(before.documents[0]?.externalRef);
        expect(otherFolder.documents[0]?.externalRef).not.toBe(before.documents[0]?.externalRef);
    });

    it("is the same ref on every poll of the same message", async () => {
        const first = await parseMessage(load("no-message-id.eml"), 7, INTERNAL_DATE, NO_CAP, ORIGIN);
        const second = await parseMessage(load("no-message-id.eml"), 7, new Date(), NO_CAP, ORIGIN);

        expect(second.documents[0]?.externalRef).toBe(first.documents[0]?.externalRef);
    });

    it("still parses without an origin, for a caller that has no mailbox behind it", async () => {
        const message = await parseMessage(load("no-message-id.eml"), 47, INTERNAL_DATE, NO_CAP);

        expect(message.documents[0]?.externalRef).toBe("<uid.47@local>#0");
    });
});

/**
 * The envelope address the ingest gates on *before* any of the above runs.
 *
 * It is normalised exactly the way `parseMessage` normalises the header address, because the ingest
 * checks both against one allowlist — and a gate whose two halves disagree about what an address is
 * is not a gate. The cases that matter are the ones where the server gives us less than we hoped
 * for: they must produce `""`, which the allowlist refuses, and never `undefined` reaching a
 * comparison.
 */
/**
 * What one poll is allowed to download, decided before a single body comes over the wire.
 *
 * The attachment cap bounds nothing that matters on its own: it is applied after mailparser has
 * fully decoded the part, so a 30 MB attachment against a 1 MB cap still costs seconds of
 * synchronous CPU and hundreds of megabytes of memory before being discarded. This is the loop that
 * also runs the ThingStore scans, and `health.ts` calls the Runtime stale after 90 seconds — so an
 * ordinary spam batch must not be able to report the household's Runtime as unhealthy.
 */
describe("planFetch", () => {
    const MB = 1024 * 1024;
    const LIMITS = { maxMessageBytes: 40 * MB, maxTotalBytes: 64 * MB };

    function candidate(uid: number, size: number): MessageMetadata {
        return { uid, size, envelopeFrom: `s${uid}@example.com`, internalDate: INTERNAL_DATE };
    }

    it("leaves a hopeless message on the server and names it, rather than downloading it", () => {
        const plan = planFetch([candidate(1, 50 * MB), candidate(2, 1 * MB)], LIMITS);

        expect(plan.wanted.map((message) => message.uid)).toEqual([2]);
        expect(plan.oversized).toEqual([{ uid: 1, size: 50 * MB, envelopeFrom: "s1@example.com" }]);
    });

    it("stops at the byte budget rather than at the message count", () => {
        // Twenty maximum-size messages is ~700 MB of raw buffers and minutes of parsing without a
        // budget. The rest are not lost — they are still in `incoming` for the next poll.
        const spam = Array.from({ length: 20 }, (_, index) => candidate(index + 1, 34 * MB));
        const plan = planFetch(spam, LIMITS);

        expect(plan.budgetExhausted).toBe(true);
        expect(plan.wanted).toHaveLength(1);
        expect(plan.wanted.reduce((total, message) => total + message.size, 0)).toBeLessThanOrEqual(
            LIMITS.maxTotalBytes,
        );
    });

    it("always takes the first affordable message, so a fat mailbox still drains", () => {
        const plan = planFetch([candidate(1, 30 * MB), candidate(2, 1 * MB)], {
            maxMessageBytes: 40 * MB,
            maxTotalBytes: 1 * MB,
        });

        expect(plan.wanted.map((message) => message.uid)).toEqual([1]);
        expect(plan.oversized).toEqual([]);
        expect(plan.budgetExhausted).toBe(true);
    });

    it("takes everything when everything fits", () => {
        const plan = planFetch([candidate(1, 1000), candidate(2, 2000)], LIMITS);

        expect(plan.wanted).toHaveLength(2);
        expect(plan.budgetExhausted).toBe(false);
        expect(plan.oversized).toEqual([]);
    });
});

describe("envelopeAddress", () => {
    it("takes the first from-address, lowercased and bare", () => {
        expect(envelopeAddress({ from: [{ address: "User@Example.COM" }] })).toBe("user@example.com");
        expect(envelopeAddress({ from: [{ address: " anna@example.com " }] })).toBe("anna@example.com");
        // A display name never reaches here — imapflow splits it off — but the first sender wins.
        expect(envelopeAddress({ from: [{ address: "a@b.de" }, { address: "c@d.de" }] })).toBe("a@b.de");
    });

    it("is the empty address when the server gave no usable envelope", () => {
        expect(envelopeAddress(undefined)).toBe("");
        expect(envelopeAddress({})).toBe("");
        expect(envelopeAddress({ from: [] })).toBe("");
        expect(envelopeAddress({ from: [{}] })).toBe("");
    });
});
