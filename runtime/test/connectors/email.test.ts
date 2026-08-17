import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseMessage } from "../../src/connectors/email.js";

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

    it("synthesises an ExternalRef when the sender omitted the Message-ID", async () => {
        const message = await parseMessage(load("no-message-id.eml"), 47, INTERNAL_DATE, NO_CAP);

        expect(message.documents[0]?.externalRef).toBe("<uid.47@local>#0");
    });

    it("skips an oversized attachment and says so in the text", async () => {
        const message = await parseMessage(load("oversized-attachment.eml"), 48, INTERNAL_DATE, 1024);

        expect(message.documents).toHaveLength(1);
        const [document] = message.documents;
        expect(document?.attachment).toBeUndefined();
        expect(document?.externalRef).toBe("<oversized@example.net>#0");
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
