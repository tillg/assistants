/**
 * The mail ingest — the fifth scan, and the first one that does not look in the ThingStore.
 *
 * Everything here is a decision about the *household*: who may post to the letterbox, what a
 * message becomes, and what a failure means. Nothing here knows what IMAP is — `connectors/email.ts`
 * owns that, and the split is what lets this file be tested against real MIME with no server in the
 * loop.
 *
 * **The ordering is the whole of the correctness argument.** For each message: check the sender,
 * create every Document it becomes, and *then* — last, after the final `ADD_DOCUMENT` has returned
 * — move the message out of the incoming folder. A crash between the two re-reads the message on
 * the next poll, finds each `ExternalRef` already in the store, creates nothing and moves. A crash
 * the other way round — move first — loses the mail silently, and it is the User's invoice.
 * `wikai`'s ingest skill arrived at the same rule independently against the same Gmail account,
 * which is worth more than either design's reasoning on its own.
 *
 * **Three folders, not a flag.** A message that was fetched, allowed and then *failed* must not
 * stay where it was — "still here" means "try again next minute, for ever" — and must not be
 * marked done, because nothing was created. So it goes to `failed`, which is a real inbox for a
 * human. A message from a sender nobody allowed goes to `rejected`, which is a spam box: *"not for
 * us"* and *"we broke"* are different facts and must not share a folder. Everything leaves the
 * incoming folder, including spam, because a poll takes at most `maxPerPoll` messages and
 * accumulated junk would otherwise starve the invoice behind it.
 *
 * **Failure is contained at three levels**, because this scan rides in the loop that also keeps
 * Conversations moving: one Document's failure fails its message, one message's failure never
 * aborts the batch, and the whole ingest catches everything and returns a summary rather than
 * throwing. There is no backoff state and no circuit breaker — the next poll is a minute away,
 * which *is* the backoff.
 */

import { createHash } from "node:crypto";

import type { ContentStoreClient, UploadedAttachment } from "../a12/content.js";
import { eq, path as fieldPath, SPECS, ThingRepository, type ModelSpec } from "../a12/things.js";
import type { MailConfig } from "../config.js";
import {
    parseMessage,
    type EmailConnector,
    type FetchedMessage,
    type IncomingDocument,
    type IncomingMessage,
} from "../connectors/email.js";
import type { DocumentThing, Operation } from "../domain/types.js";
import { describeError, log } from "../log.js";
import { readTextLayer } from "../readers/textLayer.js";

/**
 * `Document_DM` plus its attachment group.
 *
 * The shared `SPECS.Document_DM` deliberately stops at the scalar fields — nothing else in the
 * Runtime has ever written a binary — and its `groups` mapping would be the wrong tool anyway: it
 * emits an array per group, and `Attachment` has `repeatability: 1`, which A12 serialises as a
 * plain object (the same way the root group is one). Declaring it as a "field" whose value happens
 * to be the object `ContentStoreClient.upload` already returns produces exactly the shape
 * `ADD_DOCUMENT` wants, and leaves the shared spec untouched for every other caller.
 */
const DOCUMENT_WITH_ATTACHMENT: ModelSpec = {
    ...SPECS.Document_DM,
    fields: { ...SPECS.Document_DM.fields, attachment: "Attachment" },
};

/** What a Document with no attachment is: prose for an LLM to read. */
const TEXT_MEDIA_TYPE = "text/plain";

/** The one attachment type that carries its own text, and the only one the arrival path reads. */
const PDF_MEDIA_TYPE = "application/pdf";

/** The Operation Thing that is this ingest's switch in the web application (ADR-0019). */
const OPERATION_KEY = "email.receive";

/** `Document_DM`'s `Title` and `ExternalRef` both stop here. */
const MAX_FIELD_LENGTH = 200;

/**
 * The store's ceiling on an `exact_match` value, measured in `things.ts`. It bounds both the
 * idempotency key and the `ExternalRef` we file a Document under, because a reference the store
 * cannot search for is a reference that cannot answer "has this landed?" — and a message whose
 * duplicate check throws would go to `failed` on every retry, for ever.
 */
const MAX_SEARCHABLE_LENGTH = 100;

/**
 * The mailbox, narrowed to what the ingest uses.
 *
 * Derived from {@link EmailConnector} rather than written out, so it cannot drift from the class,
 * and structural rather than nominal so a test can hand over an in-memory mailbox instead of
 * standing up an IMAP server for a decision that has nothing to do with the protocol.
 */
export type MailConnector = Pick<EmailConnector, "fetch" | "move" | "ensureFolders">;

/** The Content Store, narrowed the same way and for the same reason. */
export type AttachmentUploader = Pick<ContentStoreClient, "upload">;

export interface MailIngestDeps {
    readonly config: MailConfig;
    readonly connector: MailConnector;
    readonly content: AttachmentUploader;
    readonly things: ThingRepository;
    readonly now?: () => Date;
}

/**
 * What one poll did. Every message is in exactly one of `rejected`, `failed` or "handled", and a
 * handled one contributes to `created`, to `skipped`, or to both — a partly-landed message that is
 * retried is the ordinary case, not an exception.
 */
export interface MailIngestSummary {
    /** Messages read out of the incoming folder. Never more than `maxPerPoll`. */
    fetched: number;
    /** Messages whose sender is on nobody's list. Nothing was read and nothing created. */
    rejected: number;
    /** Documents created in the ThingStore. */
    created: number;
    /** Documents that were already there under this `ExternalRef`. */
    skipped: number;
    /** Messages that threw. Their Documents that did land stay landed. */
    failed: number;
}

/**
 * May this sender post to the letterbox?
 *
 * Three properties, all of them safety rather than convenience:
 *
 *   - **An empty allowlist allows nobody.** Not everybody. A default that fails open on a public
 *     address turns spam into Conversations and LLM spend on the first day it is misconfigured.
 *   - **The bare address is compared**, so `"Dr X" <a@b.de>` is `a@b.de`. The Connector already
 *     strips the display name off the envelope, but this function is also the one a human reads to
 *     decide whether the gate is sound, and a gate that depends on its caller having tidied up is
 *     not one.
 *   - **Equality, never containment.** `user@example.com.attacker.io` contains an allowed address
 *     and is not one, and registering a domain to exploit a substring match costs a few euros.
 */
export function isAllowedSender(from: string, allowlist: readonly string[]): boolean {
    const address = bareAddress(from);
    if (address === "") return false;
    return allowlist.some((entry) => bareAddress(entry) === address);
}

/** `"Dr X" <a@b.de>` → `a@b.de`; anything else, lowercased and trimmed. */
function bareAddress(value: string): string {
    const angled = /<([^>]*)>/.exec(value);
    return (angled?.[1] ?? value).trim().toLowerCase();
}

/**
 * One poll of the letterbox.
 *
 * Returns a summary and never throws: an unreachable mailbox, a refused password or a mailbox
 * serving garbage must not take the scans that keep already-running Conversations moving with it.
 */
export async function runMailIngest(deps: MailIngestDeps): Promise<MailIngestSummary> {
    const summary: MailIngestSummary = { fetched: 0, rejected: 0, created: 0, skipped: 0, failed: 0 };
    const { config, connector } = deps;

    // The default, and not an error: a household that has not set a mailbox up has no letterbox.
    // Checked before anything else so a disabled ingest opens no socket at all.
    if (config.host.trim() === "") return summary;

    try {
        // The switch in the web application, read every poll so turning it off stops the letterbox
        // without a restart. Before `ensureFolders`, so a switched-off ingest opens no socket at all.
        if (!(await isSwitchedOn(deps))) return summary;

        // Up front rather than on demand: a missing `failed` label at the moment something fails is
        // the worst possible time to discover it. Existing folders are left alone.
        await connector.ensureFolders([
            config.folderIncoming,
            config.folderProcessed,
            config.folderFailed,
            config.folderRejected,
        ]);

        const messages = await connector.fetch(config.folderIncoming, config.maxPerPoll);
        summary.fetched = messages.length;

        for (const message of messages) {
            await handleMessage(deps, message, summary);
        }
    } catch (error) {
        // The mailbox itself, or something before the first message. Logged, and the summary says
        // what did happen; the next poll is a minute away and is the retry.
        log.error("the mail ingest failed", { error: describeError(error) });
    }

    if (summary.fetched > 0) {
        log.info("polled the letterbox", { ...summary });
    }
    return summary;
}

/**
 * Is `email.receive` switched on?
 *
 * Three readings had to be chosen between, and the choice is not the same one
 * `inbound/server.ts` makes — which is worth spelling out, because the two look alike:
 *
 *   - **`Enabled: false` stops the poll.** The explicit off is the only thing that means off, the
 *     same tri-state `grantedTo()` and the inbox route already give it: a Thing created by hand with
 *     the box untouched is not switched off.
 *   - **No Operation Thing at all means on.** The inbox route reads an absent Thing as *off*
 *     because it is a check that **grants access** — it opens a route to a caller. This one grants
 *     nothing: the gate on this path is the sender allowlist, which comes from configuration, is
 *     read below on every single message, and cannot be opened by a Thing that is missing. So an
 *     absent catalogue entry here says something about the catalogue — bootstrap has not seeded it
 *     yet, or somebody deleted a row — and nothing about whether the household wants its post. The
 *     architecture says no Assistant is granted `email.receive`; the ingest calls the
 *     Implementation directly, so absence cannot be read as "not permitted" the way a dropped grant
 *     is.
 *   - **A store that cannot be read means on, too**, for the same reason and one more: the
 *     letterbox stopping because the catalogue was briefly unreadable would hold the User's post
 *     back for no gain, and a poll made against a store that is down creates nothing anyway — the
 *     `ExternalRef` query is the very next thing that would fail, and it fails the message into
 *     `failed`, which is a folder a human reads. "I could not find out" must never mean "go ahead"
 *     on a check that grants access. This is not one.
 *
 * Two Things carrying the same key are read as off if *either* says off: for a switch, the explicit
 * off is the instruction, and an ambiguous catalogue is not a reason to keep the post flowing.
 */
async function isSwitchedOn(deps: MailIngestDeps): Promise<boolean> {
    try {
        const found = await deps.things.search<Operation>(
            SPECS.Operation_DM,
            eq(fieldPath(SPECS.Operation_DM, "key"), OPERATION_KEY),
            2,
        );
        const off = found.some((operation) => operation.data.enabled === false);
        if (off) log.debug("the mail ingest is switched off on its Operation Thing", { key: OPERATION_KEY });
        return !off;
    } catch (error) {
        log.warn("could not read the mail ingest's Operation Thing; polling anyway", {
            key: OPERATION_KEY,
            error: describeError(error),
        });
        return true;
    }
}

/**
 * One message, from parsing to the move that ends it.
 *
 * The move is the last statement on every path, and each path moves it exactly once — that is the
 * property to preserve if this function is ever edited. A failure to move is caught separately
 * from a failure to ingest, because the two mean different things: the second leaves work undone,
 * and the first leaves a message that will simply be seen again and skipped.
 */
async function handleMessage(
    deps: MailIngestDeps,
    fetched: FetchedMessage,
    summary: MailIngestSummary,
): Promise<void> {
    const { config, connector } = deps;
    try {
        // AUTHORISE FIRST, PARSE SECOND. The envelope address comes off the IMAP FETCH without any
        // MIME being touched, so a stranger's message is declined for the price of a string
        // comparison. The other order — which this had — fully parses the message first, which on a
        // full poll means up to `maxPerPoll` × `maxAttachmentBytes` of base64 decoded into this
        // process's memory on behalf of senders nobody vouched for. The mailbox is the first
        // untrusted input this system has, and the parser is the largest piece of foreign code it
        // reaches; the less of it a stranger can start, the better.
        if (!isAllowedSender(fetched.envelopeFrom, config.allowedSenders)) {
            reject(fetched.uid,fetched.envelopeFrom, summary);
            await connector.move(fetched.uid, config.folderIncoming, config.folderRejected);
            return;
        }

        const message = await parseMessage(
            fetched.raw,
            fetched.uid,
            fetched.internalDate,
            config.maxAttachmentBytes,
        );

        // BOTH must be allowed, and the second check is kept rather than replaced. The envelope
        // sender and the `From:` header are different facts — the envelope is who handed the message
        // to the server, the header is who the message claims to be from, and forging the second is
        // one line of SMTP. Whichever of the two a human had in mind when they added an address to
        // the allowlist, they did not mean "and the other one may be anybody". The check costs a
        // string comparison against a message that is already parsed.
        if (!isAllowedSender(message.from, config.allowedSenders)) {
            reject(fetched.uid,message.from, summary);
            await connector.move(fetched.uid, config.folderIncoming, config.folderRejected);
            return;
        }

        for (const document of message.documents) {
            await ingestDocument(deps, message, document, summary);
        }

        // LAST. See the note at the top of the file.
        await connector.move(fetched.uid, config.folderIncoming, config.folderProcessed);
    } catch (error) {
        summary.failed += 1;
        log.error("a mail could not be ingested; moving it to the failed folder", {
            uid: fetched.uid,
            error: describeError(error),
        });
        try {
            await connector.move(fetched.uid, config.folderIncoming, config.folderFailed);
        } catch (moveError) {
            // Both the ingest and the move failed, which almost always means the mailbox itself is
            // gone. The message stays where it is and is seen again next poll; whatever Documents
            // it did produce are skipped then.
            log.error("a failed mail could not be moved out of the incoming folder", {
                uid: fetched.uid,
                error: describeError(moveError),
            });
        }
    }
}

/**
 * Count and log one refusal.
 *
 * Only the address is logged — the subject of a mail nobody vouched for is not worth putting in the
 * household's log, and after the envelope check there is not even a parsed subject to log.
 */
function reject(uid: number, from: string, summary: MailIngestSummary): void {
    log.info("a mail from a sender who is not on the allowlist was rejected", { uid, from });
    summary.rejected += 1;
}

/**
 * One Document: has it landed already, upload its binary, create it.
 *
 * The duplicate check is a **query against the ThingStore**, not a local record of what has been
 * read. The store is the Authority for Documents (ADR-0006); a second store of "mail I have seen"
 * would be a second thing that can disagree with it, and would be wrong every time somebody deleted
 * a Document by hand.
 *
 * It throws on any failure, which is what sends the whole message to `failed`. Documents created
 * before it threw stay created — they are real Things with real `ExternalRef`s, and a retry after
 * the User moves the message back skips them and creates only what is missing.
 */
async function ingestDocument(
    deps: MailIngestDeps,
    message: IncomingMessage,
    document: IncomingDocument,
    summary: MailIngestSummary,
): Promise<void> {
    const externalRef = storableRef(document.externalRef);

    const existing = await deps.things.search<DocumentThing>(
        SPECS.Document_DM,
        eq(fieldPath(SPECS.Document_DM, "externalRef"), externalRef),
        1,
    );
    if (existing.length > 0) {
        log.debug("a Document for this mail is already in the store", { externalRef });
        summary.skipped += 1;
        return;
    }

    let attachment: UploadedAttachment | undefined;
    if (document.attachment) {
        attachment = await deps.content.upload(
            document.attachment.filename,
            document.attachment.mimeType,
            document.attachment.bytes,
        );
    }

    const extractedText = await withTextLayer(document);

    await deps.things.create(DOCUMENT_WITH_ATTACHMENT, {
        title: capped(document.title, MAX_FIELD_LENGTH),
        // A Document with no `ReceivedAt` sorts nowhere and reads as if it never arrived. The
        // Connector always provides one; this is the belt for the day it cannot.
        receivedAt: document.receivedAt || isoStamp(deps.now?.() ?? new Date()),
        source: "email",
        // The attachment is what the Document *is* when there is one; without one it is the body,
        // which is prose.
        mediaType: document.attachment?.mimeType ?? TEXT_MEDIA_TYPE,
        externalRef,
        extractedText,
        ...(attachment ? { attachment } : {}),
        // The same key, so the store's own search-then-create is a second guard behind the
        // ExternalRef query above — two callers polling at once converge on one Thing.
        idempotencyKey: externalRef,
    });

    summary.created += 1;
    log.info("a mail became a Document", { uid: message.uid, externalRef });
}

/**
 * The Document's text, with a PDF's own text layer read in when there is nothing else.
 *
 * The Receptionist is woken by a Document, and a Document with no text is one it cannot classify —
 * so without this, the first thing a forwarded invoice costs is a Turn spent discovering that it has
 * nothing to read. The text layer is already inside the bytes we just uploaded; pulling it out here
 * is what makes the Document classifiable at the moment it materialises.
 *
 * Three rules, all of them about what arrival is allowed to be:
 *
 *   - **The mail body always wins.** *"Die Zahnarztrechnung für Anna, ist schon bezahlt"* is the
 *     covering note, and it is the most useful sentence in the whole message. The text layer fills a
 *     Document that would otherwise be empty; it never replaces what the User wrote.
 *   - **Nothing here may fail the message.** Not a `not-a-pdf`, not a `no-text-layer`, and not a
 *     throw from the reader either. A Document with no text is exactly the state the reading ladder
 *     already handles further along; a message in `failed` because a PDF was encrypted is a message
 *     a human now has to look at for nothing.
 *   - **Arrival may translate; arrival may not spend.** No vision, no OCR, nothing that costs money
 *     — the text layer is the free rung of the ladder, and the free rung is the only one the post
 *     may take on its own.
 */
async function withTextLayer(document: IncomingDocument): Promise<string> {
    const attachment = document.attachment;
    if (!attachment || attachment.mimeType !== PDF_MEDIA_TYPE) return document.extractedText;
    if (document.extractedText.trim() !== "") return document.extractedText;

    try {
        const outcome = await readTextLayer(attachment.bytes);
        if (outcome.kind === "text") {
            log.debug("read a forwarded PDF's text layer on arrival", {
                filename: attachment.filename,
                pages: outcome.pages,
                characters: outcome.text.length,
            });
            return outcome.text;
        }
        log.debug("a forwarded PDF has no text layer to read on arrival", {
            filename: attachment.filename,
            outcome: outcome.kind,
        });
    } catch (error) {
        // The reader documents itself as never throwing. This is the belt for the day that stops
        // being true: an unreadable attachment is not a reason to lose the invoice around it.
        log.info("reading a forwarded PDF's text layer threw; the Document is created without it", {
            filename: attachment.filename,
            error: describeError(error),
        });
    }
    return document.extractedText;
}

/**
 * The `ExternalRef` a Document is filed under, bounded so the store can search for it.
 *
 * A `Message-ID` is not length-limited by anything, and one over the store's `exact_match` ceiling
 * would make the duplicate check throw — sending the message to `failed` on every retry, for ever,
 * which is precisely the outcome the whole ordering exists to avoid. Hashing rather than truncating,
 * because truncation would drop the `#<part>` suffix and two invoices in one mail would collide into
 * one Document. The digest is deterministic, so a retry computes the same reference and skips.
 */
function storableRef(externalRef: string): string {
    if (externalRef.length <= MAX_SEARCHABLE_LENGTH) return externalRef;
    const digest = createHash("sha256").update(externalRef).digest("hex").slice(0, 40);
    log.warn("a mail's Message-ID is too long for the store to search; filing it under a digest", {
        externalRef: capped(externalRef, MAX_FIELD_LENGTH),
        digest,
    });
    return `mail-digest:${digest}`;
}

function capped(value: string, maxLength: number): string {
    return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

/** A12 `DateTimeType` is `yyyy-MM-dd'T'HH:mm:ss` — no milliseconds, no zone suffix. */
function isoStamp(date: Date): string {
    return date.toISOString().replace(/\.\d{3}Z$/, "");
}
