/**
 * The free rung of the reading ladder: a PDF's own text layer, extracted with `pdfjs-dist`.
 *
 * Three decisions in here are load-bearing:
 *
 *   1. **Sparse text is reported, never discarded.** A scanned invoice rarely yields exactly zero
 *      characters. It yields a handful — a `Scanned by CamScanner` watermark, a page number stamped
 *      by a fax gateway, a header the scanner's own software burned in. Handing the caller twelve
 *      characters of that noise *as if it were the invoice* is worse than saying nothing at all,
 *      because the caller will classify from it and will do so confidently.
 *
 *      This module used to answer that danger by throwing the text away below `MIN_TEXT_CHARS`
 *      (100). That was calibrated against two fixtures — a 21-character watermark and a
 *      576-character utility invoice — and two fixtures are not a population. A real dentist's
 *      invoice runs to 84 characters, a one-line payment reminder to 44, a parking receipt to 49,
 *      and every one of those has a perfect, free, exact text layer that the old rule binned. The
 *      damage ran the wrong way round: the caller was then told to pay a vision model — which can
 *      invent an amount — to read a document whose amount was already in hand and already right.
 *
 *      Both directions are harmful, so the reader reports *both facts*: the text it found, and
 *      whether that text is sparse enough to be suspect. **Deciding whether 84 characters are an
 *      invoice or a scanner artefact is judgement, and in this system judgement belongs to the
 *      Assistant, not to a constant in a library.** The reader's job is to report faithfully; the
 *      Receptionist's job is to decide. The only thing still decided here is the floor: text that
 *      is genuinely empty once trimmed is `no-text-layer`, because there is nothing to judge.
 *   2. **Nothing throws.** An encrypted, corrupt or simply-not-a-PDF attachment is an ordinary
 *      outcome on the arrival path, not an exception: post arrives as it arrives. Every failure
 *      leaves here as a `kind`, so the caller branches on a value and never has to decide which
 *      exceptions are expected.
 *   3. **A page cap is offered, never imposed.** Decoding is real work on the caller's thread, and
 *      one caller — the mail ingest — runs on the Runtime's single scan loop, where a five-hundred
 *      page attachment would hold up seven ThingStore scans and outlive the heartbeat. So there is a
 *      `maxPages` parameter, unlimited by default, and a read that hits it says so: `pages` stays
 *      the document's real length, `pagesRead` says how much was decoded, `truncated` says the two
 *      differ. Nothing here silently returns part of a document.
 *   4. **No canvas, ever.** Text extraction needs the document's content streams and nothing else.
 *      Importing the legacy Node build and asking only for `getTextContent()` keeps `canvas`,
 *      `@napi-rs/canvas` and every other native dependency out of the image — which is the whole
 *      reason this rung is free.
 *
 * The module is pure over the bytes: no store access, no config, no network, no Thing.
 */

import { getDocument, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describeForModel } from "../log.js";

/**
 * Below this many characters across the whole document, the text is *flagged* as sparse.
 *
 * A label, not a gate. It marks the band where a text layer is short enough that it might be a
 * scanner's leavings rather than the document — and the caller, who knows what the document is
 * supposed to be, is the one who resolves that. Nothing is withheld on the strength of this number,
 * so getting it slightly wrong costs a hint, not a document. Exported so callers and configuration
 * can reference the same number rather than repeat it.
 */
export const SPARSE_TEXT_CHARS = 100;

export interface TextLayerResult {
    kind: "text";
    text: string;
    /** The document's real length, always — not how much of it was read. */
    pages: number;
    /** True below `SPARSE_TEXT_CHARS`: read this before trusting the text, but the text is here. */
    sparse: boolean;
    /** How many pages were actually decoded; below `pages` only when `maxPages` cut it short. */
    pagesRead: number;
    /** `pagesRead < pages`. A partial read that looks complete is the failure mode this prevents. */
    truncated: boolean;
}

/** Reserved for a document with no extractable characters at all — there is nothing to judge. */
export interface TextLayerAbsent {
    kind: "no-text-layer";
    pages: number;
}

/** Encrypted, corrupt, truncated, or never a PDF. `pages` is unknown, hence optional. */
export interface TextLayerUnreadable {
    kind: "not-a-pdf";
    pages?: number;
    detail?: string;
}

export type TextLayerOutcome = TextLayerResult | TextLayerAbsent | TextLayerUnreadable;

/** The shape of a `getTextContent()` item we care about; the rest of pdfjs's item is irrelevant. */
interface TextItem {
    str?: string;
    hasEOL?: boolean;
}

/**
 * Extract the text layer of a PDF.
 *
 * @param bytes the attachment, exactly as it was stored
 * @param sparseBelow override for `SPARSE_TEXT_CHARS`; `0` means nothing is ever flagged sparse
 * @param maxPages stop after this many pages; `Infinity` (the default) reads the whole document
 */
export async function readTextLayer(
    bytes: Buffer,
    sparseBelow: number = SPARSE_TEXT_CHARS,
    maxPages: number = Number.POSITIVE_INFINITY,
): Promise<TextLayerOutcome> {
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
            // `maxPages` bounds **decode time**, and only that. Every page decoded here is work done
            // on whatever thread called us — for the mail ingest that is the Runtime's single scan
            // loop, whose heartbeat goes stale after ninety seconds, so a forwarded five-hundred-page
            // prospectus must not be allowed to take the loop with it. That is a different concern
            // from the ingest's character cap on what it *stores and prompts with*: one bounds the
            // work, the other bounds the payload, and a document can be small in pages and vast in
            // characters or the reverse. Both caps are needed; neither replaces the other.
            const pagesRead = Math.max(0, Math.min(pages, Math.floor(maxPages)));
            const perPage: string[] = [];
            for (let number = 1; number <= pagesRead; number++) {
                const page = await document.getPage(number);
                const content = await page.getTextContent();
                perPage.push(joinItems(content.items as TextItem[]));
            }
            // A blank line between pages: it is the only page boundary that survives being pasted
            // into a prompt, and a reader — human or model — reads it as one.
            const text = perPage.join("\n\n").trim();
            // Said out loud, the way `readScan` says `too-many-pages`: a partial read that looks
            // complete is worse than no read, because nothing downstream can tell it is partial.
            const truncated = pagesRead < pages;

            // The floor, and the only judgement left in here: nothing at all is `no-text-layer`.
            // Everything else comes back with its characters intact and a flag saying how few.
            // A truncated read is never `no-text-layer`, even when the pages read were blank: the
            // pages that were not read might have said everything, and silence would imply they did
            // not.
            if (text.length === 0 && !truncated) return { kind: "no-text-layer", pages };
            return {
                kind: "text",
                text,
                pages,
                sparse: text.length < sparseBelow,
                pagesRead,
                truncated,
            };
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
