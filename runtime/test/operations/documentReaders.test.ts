/**
 * The two reading Operations, and the letterbox's entry in the catalogue.
 *
 * These call `execute` directly, the way `operations.test.ts` does, because what is under test is
 * one Operation's answer to one set of arguments rather than the transcript it ends up in. The
 * Content Store and the vision model are the only fakes: the ThingStore is the in-memory one every
 * other test uses, and the PDFs are the real fixtures the text-layer reader is calibrated against.
 *
 * One assertion here must never be relaxed: **a non-empty `extractedText` is not overwritten**. It
 * may be a transcription a person typed by hand — `document.requestText` is exactly that path — and
 * a reader that silently replaced it would destroy work nobody can get back.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../support/memory-store.js";
import { SPECS, ThingRepository } from "../../src/a12/things.js";
import type { A12Client } from "../../src/a12/client.js";
import {
    buildOperations,
    DOCUMENT_WITH_ATTACHMENT,
    type AttachmentDownloader,
    type VisionLimits,
} from "../../src/operations/implementations.js";
import type {
    OperationContext,
    OperationImplementation,
    OperationOutcome,
} from "../../src/operations/registry.js";
import type { FireflyConnector } from "../../src/connectors/firefly.js";
import type { VisionReader, VisionReadResult } from "../../src/llm/vision.js";
import type { DocumentThing } from "../../src/domain/types.js";

const fixtures = fileURLToPath(new URL("../fixtures/pdf/", import.meta.url));

function fixture(name: string): Buffer {
    return readFileSync(`${fixtures}${name}`);
}

/** Neither reader reads its context, so it needs only to exist. */
const CONTEXT = {
    idempotencyKey: "conversation-1:1",
} as unknown as OperationContext;

/** The Content Store, reduced to the one method the readers use, and a record of what was asked for. */
function contentStore(bytes: Buffer): AttachmentDownloader & { requested: string[] } {
    const requested: string[] = [];
    return {
        requested,
        async download(attachmentId: string): Promise<Buffer> {
            requested.push(attachmentId);
            return bytes;
        },
    };
}

/** A vision model that never leaves the process. `available: false` is the shipped default. */
function visionReader(
    input: { available?: boolean; text?: string; usage?: VisionReadResult["usage"] } = {},
): VisionReader & { calls: Array<{ bytes: number; pages: number }> } {
    const calls: Array<{ bytes: number; pages: number }> = [];
    return {
        available: input.available ?? true,
        name: "fake",
        calls,
        async read(pdf: Buffer, pageCount: number): Promise<VisionReadResult> {
            calls.push({ bytes: pdf.length, pages: pageCount });
            return {
                text: input.text ?? "Rechnung Nr. 4711\n\nGesamtbetrag 106,60 EUR",
                ...(input.usage ? { usage: input.usage } : {}),
            };
        },
    };
}

interface Stack {
    things: ThingRepository;
    operation(name: string): OperationImplementation;
    /** A Document with an attachment, unless `attachment: false`. Returns its ThingID. */
    document(fields: Partial<DocumentThing> & { attachment?: boolean }): Promise<string>;
    textOf(thingId: string): Promise<string>;
    fieldsOf(thingId: string): Promise<DocumentThing>;
}

let created = 0;

function buildStack(
    deps: {
        content?: AttachmentDownloader;
        vision?: VisionReader;
        limits?: VisionLimits;
    } = {},
): Stack {
    const store = new MemoryStore();
    const things = new ThingRepository(store as unknown as A12Client);
    const operations = buildOperations({
        things,
        // The readers never touch Firefly, and a stub that is never called is more honest than a
        // fake with methods nobody exercises.
        firefly: {} as unknown as FireflyConnector,
        ...deps,
        raiseQuestion: () => Promise.reject(new Error("no question is expected here")),
        callAssistant: () => Promise.reject(new Error("no Assistant call is expected here")),
    });

    return {
        things,
        operation(name: string): OperationImplementation {
            const found = operations.find((candidate) => candidate.name === name);
            if (!found) throw new Error(`No Operation named ${name}`);
            return found;
        },
        async document(fields): Promise<string> {
            const { attachment = true, ...rest } = fields;
            created += 1;
            const stored = await things.create(DOCUMENT_WITH_ATTACHMENT, {
                title: "Rechnung Dr. Meyer",
                source: "email",
                ...rest,
                ...(attachment
                    ? {
                          attachment: {
                              original_filename: "invoice.pdf",
                              internal_filename: "stored.pdf",
                              attachment_id: "att-1",
                              mime_type: "application/pdf",
                              size: 1494,
                          },
                      }
                    : {}),
                idempotencyKey: `document-${created}`,
            });
            return stored.thingId;
        },
        async textOf(thingId: string): Promise<string> {
            const read = await things.get<DocumentThing>(SPECS.Document_DM, `Document_DM/${thingId}`);
            return String(read.data.extractedText ?? "");
        },
        async fieldsOf(thingId: string): Promise<DocumentThing> {
            const read = await things.get<DocumentThing>(SPECS.Document_DM, `Document_DM/${thingId}`);
            return read.data;
        },
    };
}

/** The `value` of an outcome, with a failure that names the outcome rather than `undefined`. */
function valueOf(outcome: OperationOutcome): Record<string, unknown> {
    expect(outcome.kind).toBe("value");
    if (outcome.kind !== "value") throw new Error("unreachable");
    return outcome.value as Record<string, unknown>;
}

describe("document.extractText", () => {
    it("stores the text layer and reports the pages and characters it found", async () => {
        const content = contentStore(fixture("born-digital-invoice.pdf"));
        const stack = buildStack({ content });
        const thingId = await stack.document({});

        const outcome = await stack.operation("document.extractText").execute({ thingId }, CONTEXT);

        expect(valueOf(outcome)).toEqual({ pages: 1, characters: expect.any(Number) });
        expect(content.requested).toEqual(["att-1"]);
        expect(await stack.textOf(thingId)).toContain("Rechnungsnummer: 2026-04711");
    });

    it("touches no field on the Document but extractedText", async () => {
        const stack = buildStack({ content: contentStore(fixture("born-digital-invoice.pdf")) });
        const thingId = await stack.document({ classification: "unclassified", externalRef: "<a@b>" });
        const before = await stack.fieldsOf(thingId);

        await stack.operation("document.extractText").execute({ thingId }, CONTEXT);

        const after = await stack.fieldsOf(thingId);
        expect(after.title).toBe(before.title);
        expect(after.source).toBe(before.source);
        expect(after.classification).toBe("unclassified");
        expect(after.externalRef).toBe("<a@b>");
        // And the attachment survives, which is the field this projection deliberately does not map.
        const raw = await stack.things.get<Record<string, unknown>>(
            DOCUMENT_WITH_ATTACHMENT,
            `Document_DM/${thingId}`,
        );
        expect((raw.data["attachment"] as { attachment_id?: string }).attachment_id).toBe("att-1");
    });

    it("reports no-text-layer as a VALUE, because a scan is behaving exactly as expected", async () => {
        // The likeliest outcome on a forwarded scan, and the one that tells the caller to try the
        // next rung. An `error` here would put a red entry in the transcript for a document that is
        // doing nothing wrong.
        const stack = buildStack({ content: contentStore(fixture("scanned-no-text.pdf")) });
        const thingId = await stack.document({});

        const outcome = await stack.operation("document.extractText").execute({ thingId }, CONTEXT);

        expect(outcome.kind).toBe("value");
        expect(valueOf(outcome)).toEqual({ reason: "no-text-layer", pages: 1 });
        expect(await stack.textOf(thingId)).toBe("");
    });

    it("STORES a short text layer and says it is short, instead of throwing it away", async () => {
        // 84 characters of a real dentist's invoice. The amount is in there, exact and free. The
        // old rule called this a scan and pointed the Receptionist at a paid vision model, which is
        // the one reader in the ladder that can invent a number.
        const stack = buildStack({ content: contentStore(fixture("short-invoice.pdf")) });
        const thingId = await stack.document({});

        const outcome = await stack.operation("document.extractText").execute({ thingId }, CONTEXT);

        const value = valueOf(outcome);
        expect(value["pages"]).toBe(1);
        expect(value["sparse"]).toBe(true);
        expect(value["characters"]).toBeGreaterThan(0);
        // Legible to the model: how much was found, and that reading it is now its call.
        expect(String(value["note"])).toContain(String(value["characters"]));
        expect(await stack.textOf(thingId)).toContain("Betrag: 84,20 EUR");
    });

    it("stores a scanner watermark too — labelled, so the Receptionist can reject it", async () => {
        // The other half of the same judgement, and the reason the flag exists. Nothing here can
        // tell 21 characters of watermark from 44 characters of payment reminder; the Receptionist,
        // which has the covering note and the subject line, can.
        const stack = buildStack({ content: contentStore(fixture("scanned-watermark.pdf")) });
        const thingId = await stack.document({});

        const outcome = await stack.operation("document.extractText").execute({ thingId }, CONTEXT);

        expect(valueOf(outcome)["sparse"]).toBe(true);
        expect(await stack.textOf(thingId)).toContain("CamScanner");
    });

    it("says nothing about sparseness when the text layer is a full document", async () => {
        const stack = buildStack({ content: contentStore(fixture("born-digital-invoice.pdf")) });
        const thingId = await stack.document({});

        const outcome = await stack.operation("document.extractText").execute({ thingId }, CONTEXT);

        expect(valueOf(outcome)).not.toHaveProperty("sparse");
        expect(valueOf(outcome)).not.toHaveProperty("note");
    });

    it("reports not-a-pdf as a value when the bytes cannot be opened", async () => {
        const stack = buildStack({ content: contentStore(fixture("corrupt.pdf")) });
        const thingId = await stack.document({});

        const outcome = await stack.operation("document.extractText").execute({ thingId }, CONTEXT);

        expect(valueOf(outcome)).toEqual({ reason: "not-a-pdf" });
    });

    it("reports no-attachment rather than downloading nothing", async () => {
        const content = contentStore(fixture("born-digital-invoice.pdf"));
        const stack = buildStack({ content });
        const thingId = await stack.document({ attachment: false });

        const outcome = await stack.operation("document.extractText").execute({ thingId }, CONTEXT);

        expect(valueOf(outcome)).toEqual({ reason: "no-attachment" });
        expect(content.requested).toEqual([]);
    });

    it("REFUSES to overwrite text the Document already has", async () => {
        // Never relax this. The text may be a human transcription, and there is no undo.
        const content = contentStore(fixture("born-digital-invoice.pdf"));
        const stack = buildStack({ content });
        const thingId = await stack.document({ extractedText: "typed out by hand" });

        const outcome = await stack.operation("document.extractText").execute({ thingId }, CONTEXT);

        expect(valueOf(outcome)).toEqual({ skipped: "already-has-text" });
        expect(await stack.textOf(thingId)).toBe("typed out by hand");
        // Not even downloaded: the refusal happens before anything is read.
        expect(content.requested).toEqual([]);
    });

    it("overwrites it when replace is asked for, and when it is asked for as a string", async () => {
        for (const replace of [true, "true"]) {
            const stack = buildStack({ content: contentStore(fixture("born-digital-invoice.pdf")) });
            const thingId = await stack.document({ extractedText: "typed out by hand" });

            const outcome = await stack
                .operation("document.extractText")
                .execute({ thingId, replace }, CONTEXT);

            expect(valueOf(outcome)["pages"]).toBe(1);
            expect(await stack.textOf(thingId)).toContain("Rechnungsnummer");
        }
    });

    it("says so when no Content Store is configured, rather than failing obscurely", async () => {
        const stack = buildStack({});
        const thingId = await stack.document({});

        const outcome = await stack.operation("document.extractText").execute({ thingId }, CONTEXT);

        expect(outcome.kind).toBe("error");
    });

    it("needs a thingId", async () => {
        const stack = buildStack({ content: contentStore(fixture("born-digital-invoice.pdf")) });
        const outcome = await stack.operation("document.extractText").execute({}, CONTEXT);
        expect(outcome.kind).toBe("error");
    });

    it("reconciles from the Document, which is where the answer is", async () => {
        const stack = buildStack({ content: contentStore(fixture("born-digital-invoice.pdf")) });
        const extractText = stack.operation("document.extractText");
        const empty = await stack.document({});
        const filled = await stack.document({ extractedText: "already there" });

        expect(await extractText.reconcile!({ thingId: empty }, CONTEXT)).toEqual({
            kind: "error",
            message: expect.stringContaining("safe"),
        });
        expect(valueOf((await extractText.reconcile!({ thingId: filled }, CONTEXT))!)).toEqual({
            characters: "already there".length,
            alreadyExtracted: true,
        });
        // BUG-06: a `replace` re-read cannot be proven landed from a non-empty field — the old text
        // is still there. So reconcile must report interrupted, not alreadyExtracted.
        expect(await extractText.reconcile!({ thingId: filled, replace: true }, CONTEXT)).toEqual({
            kind: "error",
            message: expect.stringContaining("interrupted"),
        });
    });
});

describe("document.readScan", () => {
    it("reports unavailable when no vision model is configured — the shipped default", async () => {
        const content = contentStore(fixture("scanned-watermark.pdf"));
        // No `vision` dependency at all, which is what a Runtime with no `vision` profile builds.
        const stack = buildStack({ content });
        const thingId = await stack.document({});

        const outcome = await stack.operation("document.readScan").execute({ thingId }, CONTEXT);

        expect(valueOf(outcome)).toEqual({ reason: "unavailable" });
        expect(content.requested).toEqual([]);
    });

    it("transcribes the scan, stores it, and returns the usage it cost", async () => {
        const vision = visionReader({ usage: { promptTokens: 2400, completionTokens: 310 } });
        const stack = buildStack({ content: contentStore(fixture("scanned-watermark.pdf")), vision });
        const thingId = await stack.document({});

        const outcome = await stack.operation("document.readScan").execute({ thingId }, CONTEXT);

        expect(valueOf(outcome)).toEqual({
            pages: 1,
            characters: expect.any(Number),
            // Without this the spend is invisible: the Loop Driver adds it to the Turn's own cost.
            usage: { promptTokens: 2400, completionTokens: 310 },
        });
        expect(vision.calls).toEqual([{ bytes: expect.any(Number), pages: 1 }]);
        expect(await stack.textOf(thingId)).toContain("106,60 EUR");
    });

    it("REFUSES to overwrite text the Document already has, and honours replace", async () => {
        const vision = visionReader({ text: "read by a model" });
        const stack = buildStack({ content: contentStore(fixture("scanned-watermark.pdf")), vision });
        const thingId = await stack.document({ extractedText: "typed out by hand" });
        const readScan = stack.operation("document.readScan");

        expect(valueOf(await readScan.execute({ thingId }, CONTEXT))).toEqual({
            skipped: "already-has-text",
        });
        expect(await stack.textOf(thingId)).toBe("typed out by hand");
        // Refused before spending anything, which is the point.
        expect(vision.calls).toEqual([]);

        await readScan.execute({ thingId, replace: true }, CONTEXT);
        expect(await stack.textOf(thingId)).toBe("read by a model");
    });

    it("refuses a file over the byte cap, with the size rather than a truncated read", async () => {
        const bytes = fixture("scanned-watermark.pdf");
        const vision = visionReader();
        const stack = buildStack({
            content: contentStore(bytes),
            vision,
            limits: { visionMaxPages: 10, visionMaxBytes: 100 },
        });
        const thingId = await stack.document({});

        const outcome = await stack.operation("document.readScan").execute({ thingId }, CONTEXT);

        expect(valueOf(outcome)).toEqual({ reason: "too-large", bytes: bytes.length });
        expect(vision.calls).toEqual([]);
    });

    it("refuses a document over the page cap, with the page count", async () => {
        // A partial invoice is worse than no invoice, because it looks complete.
        const vision = visionReader();
        const stack = buildStack({
            content: contentStore(fixture("multi-page.pdf")),
            vision,
            limits: { visionMaxPages: 1, visionMaxBytes: 16 * 1024 * 1024 },
        });
        const thingId = await stack.document({});

        const outcome = await stack.operation("document.readScan").execute({ thingId }, CONTEXT);

        expect(valueOf(outcome)).toEqual({ reason: "too-many-pages", pages: 2 });
        expect(vision.calls).toEqual([]);
    });

    it("will not send bytes it cannot count the pages of", async () => {
        const vision = visionReader();
        const stack = buildStack({ content: contentStore(fixture("corrupt.pdf")), vision });
        const thingId = await stack.document({});

        const outcome = await stack.operation("document.readScan").execute({ thingId }, CONTEXT);

        expect(valueOf(outcome)).toEqual({ reason: "not-a-pdf" });
        expect(vision.calls).toEqual([]);
    });

    it("reports no-attachment", async () => {
        const stack = buildStack({
            content: contentStore(fixture("scanned-watermark.pdf")),
            vision: visionReader(),
        });
        const thingId = await stack.document({ attachment: false });

        const outcome = await stack.operation("document.readScan").execute({ thingId }, CONTEXT);

        expect(valueOf(outcome)).toEqual({ reason: "no-attachment" });
    });

    it("reconciles without spending anything a second time", async () => {
        const stack = buildStack({
            content: contentStore(fixture("scanned-watermark.pdf")),
            vision: visionReader(),
        });
        const readScan = stack.operation("document.readScan");
        const empty = await stack.document({});
        const filled = await stack.document({ extractedText: "read by a model" });

        const interrupted = await readScan.reconcile!({ thingId: empty }, CONTEXT);
        expect(interrupted).toEqual({ kind: "error", message: expect.stringContaining("money") });
        expect(valueOf((await readScan.reconcile!({ thingId: filled }, CONTEXT))!)).toEqual({
            characters: "read by a model".length,
            alreadyRead: true,
        });
        // BUG-06: a `replace` re-read over existing text cannot be proven landed, and believing it
        // wrongly also skips a paid re-read. Report interrupted, not alreadyRead.
        expect(await readScan.reconcile!({ thingId: filled, replace: true }, CONTEXT)).toEqual({
            kind: "error",
            message: expect.stringContaining("interrupted"),
        });
    });
});

describe("email.receive", () => {
    it("says the Runtime drives it, and does not go near a mailbox", async () => {
        const stack = buildStack({});

        const outcome = await stack.operation("email.receive").execute({}, CONTEXT);

        expect(valueOf(outcome)["reason"]).toBe("driven-by-the-runtime");
    });

    it("reconciles by asking whether a Document already carries that ExternalRef", async () => {
        const stack = buildStack({});
        const emailReceive = stack.operation("email.receive");
        const thingId = await stack.document({ externalRef: "<msg-1@example.com>" });

        expect(
            valueOf((await emailReceive.reconcile!({ externalRef: "<msg-1@example.com>" }, CONTEXT))!),
        ).toEqual({ thingId, alreadyReceived: true });

        expect(await emailReceive.reconcile!({ externalRef: "<never-seen@x>" }, CONTEXT)).toEqual({
            kind: "error",
            message: expect.stringContaining("<never-seen@x>"),
        });
    });
});

describe("all three", () => {
    it("are mutating, and therefore none of them is clientReadable", async () => {
        // ADR-0023: the inbox executes an Operation with no Conversation behind it, so the flag is a
        // claim that the call is safe without one. Every one of these writes to a Document.
        const stack = buildStack({});
        for (const name of ["document.extractText", "document.readScan", "email.receive"]) {
            const operation = stack.operation(name);
            expect(operation.mutating).toBe(true);
            expect(operation.clientReadable).toBeUndefined();
        }
    });

    it("all take the key argument their reconcile answers by", () => {
        // The idempotency contract: a mutating Operation is idempotent under a caller-supplied key.
        // `thingId` for the readers, `ExternalRef` for the letterbox — and each has a `reconcile`
        // that answers from that key alone.
        const stack = buildStack({});
        const keys: Record<string, string> = {
            "document.extractText": "thingId",
            "document.readScan": "thingId",
            "email.receive": "externalRef",
        };
        for (const [name, key] of Object.entries(keys)) {
            const seed = stack.operation(name).seed;
            const parameters = seed.parameters as {
                properties: Record<string, unknown>;
                required: string[];
            };
            expect(Object.keys(parameters.properties)).toContain(key);
            expect(parameters.required).toContain(key);
            expect(stack.operation(name).reconcile).toBeTypeOf("function");
        }
    });
});
