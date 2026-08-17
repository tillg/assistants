/**
 * What the reader reports, and what it refuses to decide.
 *
 * `readTextLayer` is otherwise a thin wrapper around `pdfjs-dist`, and wrapping a library is not
 * worth testing. What is worth testing is that **no extracted character is ever thrown away**, and
 * that a short text layer arrives labelled rather than suppressed — because the whole reading
 * ladder, and everything the household pays a vision model, branches on that answer.
 *
 * The short fixtures are the ones that matter now. `short-invoice.pdf` (84 characters),
 * `short-reminder.pdf` (44) and `parking-receipt.pdf` (49) are all born-digital, all exact, and all
 * of them were reported as `no-text-layer` by the earlier threshold — which had been calibrated
 * against exactly two documents that happened to straddle 100. They sit in the same character range
 * as `scanned-watermark.pdf` (21) and no arithmetic separates them, which is the point: the reader
 * reports the length, and the Receptionist reads the text and decides.
 *
 * The character counts are asserted as ranges. Rewording a fixture should not fail the suite; a
 * fixture drifting out of the sparse band, and so stopping testing what it is here to test, should.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
    SPARSE_TEXT_CHARS,
    readTextLayer,
    type TextLayerOutcome,
    type TextLayerResult,
} from "../../src/readers/textLayer.js";

const fixtures = fileURLToPath(new URL("../fixtures/pdf/", import.meta.url));

function fixture(name: string): Buffer {
    return readFileSync(`${fixtures}${name}`);
}

/** Narrowing helper: the assertions read better than a cast, and they fail with the actual kind. */
function expectText(outcome: TextLayerOutcome): TextLayerResult {
    expect(outcome.kind).toBe("text");
    if (outcome.kind !== "text") throw new Error("unreachable");
    return outcome;
}

describe("readTextLayer", () => {
    it("reads a born-digital invoice and keeps its numbers intact", async () => {
        const result = expectText(await readTextLayer(fixture("born-digital-invoice.pdf")));

        expect(result.pages).toBe(1);
        expect(result.sparse).toBe(false);
        expect(result.text).toContain("Rechnungsnummer: 2026-04711");
        expect(result.text).toContain("Gesamtbetrag");
        expect(result.text).toContain("106,60 EUR");
    });

    it("joins pages with a blank line and reads all of them", async () => {
        const result = expectText(await readTextLayer(fixture("multi-page.pdf")));

        expect(result.pages).toBe(2);
        expect(result.text).toContain("Seite 1 von 2");
        expect(result.text).toContain("Neuer Kontostand: 4.283,57 EUR");
        expect(result.text).toContain("\n\n");
    });

    it("calls a scan with no text objects at all a no-text-layer, and still counts its pages", async () => {
        const outcome = await readTextLayer(fixture("scanned-no-text.pdf"));

        expect(outcome.kind).toBe("no-text-layer");
        expect(outcome.pages).toBe(1);
    });

    it("hands back a scanner watermark, flagged sparse — labelled noise, not suppressed noise", async () => {
        // The caller is told both things: here are twenty-one characters, and twenty-one characters
        // is few. It can then see for itself that they say `Scanned by CamScanner`, which no
        // threshold could have told it.
        const result = expectText(await readTextLayer(fixture("scanned-watermark.pdf")));

        expect(result.pages).toBe(1);
        expect(result.sparse).toBe(true);
        expect(result.text).toContain("CamScanner");
    });

    it.each([
        ["short-invoice.pdf", 70, 100, "Betrag: 84,20 EUR"],
        ["short-reminder.pdf", 35, 60, "Zahlungserinnerung: 42,00 EUR"],
        ["parking-receipt.pdf", 35, 65, "Gesamt 12,50 EUR"],
    ])(
        "keeps the exact text of %s, which the old threshold binned as a scan",
        async (name, atLeast, atMost, expected) => {
            // Every one of these is born-digital: the amount is exact and free. Reporting them as
            // `no-text-layer` sent them to a paid vision model that can invent the number instead.
            const result = expectText(await readTextLayer(fixture(name)));

            expect(result.text).toContain(expected);
            expect(result.text.length).toBeGreaterThanOrEqual(atLeast);
            expect(result.text.length).toBeLessThanOrEqual(atMost);
            // Short enough to warrant a second look, and said so — but handed over regardless.
            expect(result.sparse).toBe(true);
        },
    );

    it("cannot separate the short invoices from the watermark by length, which is why it does not try", async () => {
        const watermark = expectText(await readTextLayer(fixture("scanned-watermark.pdf")));
        const invoice = expectText(await readTextLayer(fixture("short-invoice.pdf")));

        // Both under the sparse mark, both handed over whole. No number drawn between them would
        // survive the next document, so the reader draws none and reports what it read.
        expect(watermark.text.length).toBeLessThan(SPARSE_TEXT_CHARS);
        expect(invoice.text.length).toBeLessThan(SPARSE_TEXT_CHARS);
        expect(watermark.sparse && invoice.sparse).toBe(true);
    });

    it("honours an explicit sparseBelow over the default, and never withholds text for it", async () => {
        // A caller that wants everything flagged gets everything flagged...
        const strict = expectText(await readTextLayer(fixture("born-digital-invoice.pdf"), 10_000));
        expect(strict.sparse).toBe(true);
        expect(strict.text).toContain("106,60 EUR");

        // ...and a caller that wants nothing flagged still gets every character either way.
        const lenient = expectText(await readTextLayer(fixture("scanned-watermark.pdf"), 0));
        expect(lenient.sparse).toBe(false);
        expect(lenient.text).toContain("CamScanner");
    });

    it("reads every page when no cap is given, and says the read was whole", async () => {
        const result = expectText(await readTextLayer(fixture("multi-page.pdf")));

        expect(result.pages).toBe(2);
        expect(result.pagesRead).toBe(2);
        expect(result.truncated).toBe(false);
    });

    it("stops at maxPages, and never lets a partial read look complete", async () => {
        // The cap bounds decode time on the caller's thread — the mail ingest reads inside the scan
        // loop. What matters as much as stopping is saying so: `pages` is still the document's real
        // length, so a caller can tell it only has part of it.
        const result = expectText(await readTextLayer(fixture("multi-page.pdf"), SPARSE_TEXT_CHARS, 1));

        expect(result.pages).toBe(2);
        expect(result.pagesRead).toBe(1);
        expect(result.truncated).toBe(true);
        expect(result.text).toContain("Seite 1 von 2");
        expect(result.text).not.toContain("Seite 2 von 2");
    });

    it("does not call a truncated read a no-text-layer, however blank the pages it read were", async () => {
        // The unread pages might have carried the whole invoice. `no-text-layer` would assert
        // something about the document that this read never looked at.
        const outcome = await readTextLayer(fixture("multi-page.pdf"), SPARSE_TEXT_CHARS, 0);

        expect(outcome.kind).toBe("text");
        expect(expectText(outcome).truncated).toBe(true);
    });

    it("reports corrupt bytes as a value and does not throw", async () => {
        const outcome = await readTextLayer(fixture("corrupt.pdf"));

        expect(outcome.kind).toBe("not-a-pdf");
        if (outcome.kind !== "not-a-pdf") throw new Error("unreachable");
        expect(outcome.detail).toBeTruthy();
    });

    it("reports something that was never a PDF as a value and does not throw", async () => {
        const outcome = await readTextLayer(fixture("not-a-pdf.txt"));

        expect(outcome.kind).toBe("not-a-pdf");
    });

    it("never throws, whatever it is handed", async () => {
        const rubbish = [
            Buffer.alloc(0),
            Buffer.from("not even close", "utf8"),
            fixture("corrupt.pdf"),
            fixture("not-a-pdf.txt"),
        ];

        for (const bytes of rubbish) {
            await expect(readTextLayer(bytes)).resolves.toMatchObject({ kind: "not-a-pdf" });
        }
    });

    it("is pure over the bytes: the same input twice gives the same answer", async () => {
        const bytes = fixture("born-digital-invoice.pdf");
        const first = expectText(await readTextLayer(bytes));
        const second = expectText(await readTextLayer(bytes));

        expect(second.text).toBe(first.text);
    });
});
