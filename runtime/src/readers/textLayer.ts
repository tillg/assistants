/**
 * The free rung of the reading ladder: a PDF's own text layer, extracted with `pdfjs-dist`.
 *
 * Three decisions in here are load-bearing:
 *
 *   1. **"Has a text layer" is a threshold, not `length > 0`.** A scanned invoice rarely yields
 *      exactly zero characters. It yields a handful — a `Scanned by CamScanner` watermark, a page
 *      number stamped by a fax gateway, a header the scanner's own software burned in. Handing the
 *      caller twelve characters of that noise is worse than saying nothing at all, because the
 *      caller will classify from it and will do so confidently. So anything under `MIN_TEXT_CHARS`
 *      is reported as `no-text-layer`, and the calibrating fixtures live beside the tests.
 *      Getting this wrong in the lenient direction is the harmful one.
 *   2. **Nothing throws.** An encrypted, corrupt or simply-not-a-PDF attachment is an ordinary
 *      outcome on the arrival path, not an exception: post arrives as it arrives. Every failure
 *      leaves here as a `kind`, so the caller branches on a value and never has to decide which
 *      exceptions are expected.
 *   3. **No canvas, ever.** Text extraction needs the document's content streams and nothing else.
 *      Importing the legacy Node build and asking only for `getTextContent()` keeps `canvas`,
 *      `@napi-rs/canvas` and every other native dependency out of the image — which is the whole
 *      reason this rung is free.
 *
 * The module is pure over the bytes: no store access, no config, no network, no Thing.
 */

import { getDocument, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describeForModel } from "../log.js";

/**
 * Below this many characters across the whole document, the text is treated as scanner noise.
 *
 * A guess, but a calibrated one — see `test/readers/textLayer.test.ts`, where a real invoice and a
 * scanner watermark are asserted to sit either side of it with room to spare. Exported so callers
 * and configuration can reference the same number rather than repeat it.
 */
export const MIN_TEXT_CHARS = 100;

export interface TextLayerResult {
    kind: "text";
    text: string;
    pages: number;
}

export interface TextLayerAbsent {
    kind: "no-text-layer" | "not-a-pdf";
    pages?: number;
    detail?: string;
}

export type TextLayerOutcome = TextLayerResult | TextLayerAbsent;

/** The shape of a `getTextContent()` item we care about; the rest of pdfjs's item is irrelevant. */
interface TextItem {
    str?: string;
    hasEOL?: boolean;
}

/**
 * Extract the text layer of a PDF.
 *
 * @param bytes the attachment, exactly as it was stored
 * @param minChars override for `MIN_TEXT_CHARS`; `0` disables the heuristic entirely
 */
export async function readTextLayer(bytes: Buffer, minChars: number = MIN_TEXT_CHARS): Promise<TextLayerOutcome> {
    let pages = 0;
    try {
        // A fresh copy: pdfjs takes ownership of the array it is given, and the caller's Buffer is
        // very often about to be uploaded or hashed by somebody else.
        const task = getDocument({
            data: new Uint8Array(bytes),
            isEvalSupported: false,
            useSystemFonts: false,
            verbosity: VerbosityLevel.ERRORS,
        });

        const document = await task.promise;
        try {
            pages = document.numPages;
            const perPage: string[] = [];
            for (let number = 1; number <= pages; number++) {
                const page = await document.getPage(number);
                const content = await page.getTextContent();
                perPage.push(joinItems(content.items as TextItem[]));
            }
            // A blank line between pages: it is the only page boundary that survives being pasted
            // into a prompt, and a reader — human or model — reads it as one.
            const text = perPage.join("\n\n").trim();

            if (text.length < minChars) return { kind: "no-text-layer", pages };
            return { kind: "text", text, pages };
        } finally {
            await document.destroy();
        }
    } catch (error) {
        // Corrupt, truncated, encrypted, or a JPEG somebody renamed. All the same to the caller:
        // there is no text here and the next rung of the ladder is what happens next.
        return { kind: "not-a-pdf", pages, detail: describeForModel(error) };
    }
}

/**
 * Reassemble one page's items into lines.
 *
 * pdfjs hands back positioned fragments, not lines, and joining them blindly runs an invoice's
 * columns together into one unreadable string. `hasEOL` is pdfjs's own record of where the content
 * stream moved to a new line, which is as close to the original layout as text extraction gets.
 */
function joinItems(items: TextItem[]): string {
    let out = "";
    for (const item of items) {
        out += item.str ?? "";
        if (item.hasEOL) out += "\n";
    }
    return out;
}
