/**
 * The threshold, calibrated.
 *
 * These tests exist mostly to pin one number down. `readTextLayer` is otherwise a thin wrapper
 * around `pdfjs-dist`, and wrapping a library is not worth testing; deciding *when a PDF counts as
 * having a text layer* is, because the whole reading ladder branches on that answer.
 *
 * The two fixtures that matter are `born-digital-invoice.pdf` and `scanned-watermark.pdf`. If they
 * ever stop landing on opposite sides of `MIN_TEXT_CHARS` with obvious daylight between them, the
 * heuristic is wrong and the fix is the heuristic, never the assertion.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MIN_TEXT_CHARS, readTextLayer, type TextLayerOutcome } from "../../src/readers/textLayer.js";

const fixtures = fileURLToPath(new URL("../fixtures/pdf/", import.meta.url));

function fixture(name: string): Buffer {
    return readFileSync(`${fixtures}${name}`);
}

/** Narrowing helper: the assertions read better than a cast, and they fail with the actual kind. */
function expectText(outcome: TextLayerOutcome): { text: string; pages: number } {
    expect(outcome.kind).toBe("text");
    if (outcome.kind !== "text") throw new Error("unreachable");
    return outcome;
}

describe("readTextLayer", () => {
    it("reads a born-digital invoice and keeps its numbers intact", async () => {
        const result = expectText(await readTextLayer(fixture("born-digital-invoice.pdf")));

        expect(result.pages).toBe(1);
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

    it("calls a scanner watermark a no-text-layer rather than handing back the noise", async () => {
        const outcome = await readTextLayer(fixture("scanned-watermark.pdf"));

        expect(outcome.kind).toBe("no-text-layer");
        expect(outcome.pages).toBe(1);
    });

    it("puts the two calibrating fixtures on opposite sides of the threshold, with daylight", async () => {
        // Read both with the threshold effectively disabled, so the raw lengths are visible.
        const invoice = expectText(await readTextLayer(fixture("born-digital-invoice.pdf"), 0));
        const watermark = expectText(await readTextLayer(fixture("scanned-watermark.pdf"), 0));

        expect(watermark.text.trim().length).toBeLessThan(MIN_TEXT_CHARS / 2);
        expect(invoice.text.trim().length).toBeGreaterThan(MIN_TEXT_CHARS * 2);
    });

    it("honours an explicit minChars over the default", async () => {
        const strict = await readTextLayer(fixture("born-digital-invoice.pdf"), 10_000);
        expect(strict.kind).toBe("no-text-layer");

        const lenient = await readTextLayer(fixture("scanned-watermark.pdf"), 5);
        expect(lenient.kind).toBe("text");
    });

    it("reports corrupt bytes as a value and does not throw", async () => {
        const outcome = await readTextLayer(fixture("corrupt.pdf"));

        expect(outcome.kind).toBe("not-a-pdf");
        if (outcome.kind === "text") throw new Error("unreachable");
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
