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
 * **The move is not part of the ingest.** Whatever a message turned out to be — processed, rejected
 * or failed — the move that files it happens *outside* the block that decided so, in a `try` of its
 * own. A transient IMAP error on that last statement is not a reason to re-file a message somewhere
 * it does not belong: the message simply stays in `incoming`, the next poll re-reads it, the
 * `ExternalRef` query skips every Document already created, and it is moved then. A move that
 * failed is therefore self-healing; a move to the *wrong* folder is not, because nothing ever looks
 * in `processed` or `rejected` again.
 *
 * **Failure is contained at three levels**, because this scan rides in the loop that also keeps
 * Conversations moving: one Document's failure fails its message, one message's failure never
 * aborts the batch, and one message's failure to *move* is neither. There is no backoff state and
 * no circuit breaker — the next poll is a minute away, which *is* the backoff.
 *
 * **One poll, one connection.** The whole of a poll — the folder check, the fetch, and every move
 * it decides on — runs inside a single `connector.session(...)`. Each of those used to open, log in
 * and log out on its own, which at `maxPerPoll: 20` is `2 + N` = 22 TLS handshakes and 22 IMAP
 * logins a minute against a provider that throttles rapid reconnects — with twenty handshake-plus-
 * login latencies sitting *inside* the scan loop that also keeps Conversations moving. Nothing about
 * the session outlives the poll, so a connection that dies mid-poll fails that poll and the next one
 * starts fresh a minute later: the same failure mode, at a twentieth of the handshakes.
 *
 * **A message too large to download is filed, not ignored.** `fetchBatch` names the messages it
 * declined to fetch on the server's own `RFC822.SIZE`, and they are the one category that does not
 * reach {@link handleMessage} at all — there are no bytes to decide anything from. Left alone they
 * would stay in the incoming folder and be declined again every minute for ever, and because a poll
 * takes at most `maxPerPoll` messages they would eventually crowd the User's actual invoices out of
 * the batch. So they are moved to `failed`, which is a folder a human reads, and counted there.
 *
 * **A wholesale failure is the one thing that leaves here as an exception.** Cannot connect, cannot
 * authenticate, cannot list the folders: nothing was attempted, no message has an outcome, and the
 * Watcher — which is the only thing that can remember one outage across polls — is the right place
 * to decide how often to say so. Everything per-message stays non-fatal and is reported in the
 * summary, exactly as before. See {@link MailboxUnreachable}.
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
    type MailSession,
    type OversizedMessage,
} from "../connectors/email.js";
import type { DocumentThing, Operation } from "../domain/types.js";
import { describeError, log } from "../log.js";
import { readTextLayer, SPARSE_TEXT_CHARS } from "../readers/textLayer.js";

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
 * How much extracted text a Document may carry.
 *
 * `Document_DM.ExtractedText` has no `maxLength`, which reads as "no limit" and is in fact a limit
 * paid by somebody else: the Receptionist is woken by a Document and the Document's text goes into
 * the prompt of the very next Turn. A forwarded 500-page contract would therefore be extracted in
 * full inside the scan loop, stored whole, and then billed per token on arrival — for a household
 * whose actual post is an invoice of a few kilobytes.
 *
 * 20,000 characters is roughly 5,000 tokens: comfortably more than any household document anybody
 * has ever forwarded here, and small enough that a pathological one cannot dominate a Turn. It is a
 * ceiling for the absurd case, not a budget the ordinary case is meant to feel.
 */
export const MAX_EXTRACTED_TEXT_LENGTH = 20_000;

/**
 * Said *in the stored text*, not only in the log.
 *
 * A Document whose text stops mid-sentence is read — by a human and by a model — as a document that
 * ends there, and the model will classify from it confidently. Saying so is the same courtesy the
 * Connector already pays with its oversized-attachment note.
 */
const TRUNCATION_NOTE = `\n\n[This text was truncated at ${MAX_EXTRACTED_TEXT_LENGTH} characters; the rest was not stored.]`;

/**
 * How many pages of a forwarded PDF arrival may decode.
 *
 * **This is not a duplicate of {@link MAX_EXTRACTED_TEXT_LENGTH}, and deleting either one because
 * "there are two caps" breaks something.** They bound different quantities:
 *
 *   - `MAX_EXTRACTED_TEXT_LENGTH` bounds what is **stored and prompted with**. It is paid by the
 *     Receptionist, per token, on the very next Turn.
 *   - `ARRIVAL_MAX_PAGES` bounds what is **decoded**, in the scan loop, before a single character is
 *     stored. That cost is paid in wall-clock time by every other scan in the same loop, and by
 *     `health.ts`, which calls the Runtime stale after ninety seconds.
 *
 * A document can be short in pages and vast in characters, or five hundred pages of almost nothing.
 * Twenty pages matches the generosity `readScan` extends to household post (whose own cap is 10),
 * finishes a text-layer decode in well under a second, and stops a forwarded prospectus.
 */
export const ARRIVAL_MAX_PAGES = 20;

/**
 * Said in the stored text, for the same reason {@link TRUNCATION_NOTE} is.
 *
 * A Document whose text stops at page twenty of five hundred and does not say so reads — to a human
 * and to a model — as a document that ends there, and the model will classify from it confidently.
 */
function pageTruncationNote(pagesRead: number, pages: number): string {
    return `\n\n[Only the first ${pagesRead} of ${pages} pages were read on arrival; the rest was not extracted.]`;
}

/**
 * The mailbox could not be reached, authenticated with, or listed.
 *
 * The one failure this module raises rather than reports, because it is the only one that is *not*
 * about a message: nothing was fetched, so no message has an outcome and the summary has nothing to
 * say. It exists as a type so the Watcher can tell it apart from a bug in this file, and so a
 * mailbox that has been down for an hour costs one log line rather than sixty.
 */
export class MailboxUnreachable extends Error {
    constructor(cause: unknown) {
        super(`the letterbox could not be read: ${describeError(cause)}`);
        this.name = "MailboxUnreachable";
        this.cause = cause;
    }
}

/**
 * The mailbox, narrowed to what the ingest uses.
 *
 * Derived from {@link EmailConnector} rather than written out, so it cannot drift from the class,
 * and structural rather than nominal so a test can hand over an in-memory mailbox instead of
 * standing up an IMAP server for a decision that has nothing to do with the protocol.
 *
 * Only `session` is called from here; the other three are kept in the type because they are what a
 * session *is*, and narrowing to `session` alone would let a fake satisfy the ingest while being
 * unable to satisfy anything else that holds a mailbox.
 */
export type MailConnector = Pick<EmailConnector, "fetch" | "fetchBatch" | "move" | "ensureFolders" | "session">;

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
    /**
     * Messages whose bytes were actually read out of the incoming folder. Never more than
     * `maxPerPoll`, and never counting the ones that were too large to download — those were
     * considered and declined, not read, and they are counted in `failed`.
     */
    fetched: number;
    /** Messages whose sender is on nobody's list. Nothing was read and nothing created. */
    rejected: number;
    /** Documents created in the ThingStore. */
    created: number;
    /** Documents that were already there under this `ExternalRef`. */
    skipped: number;
    /**
     * Messages that threw, plus the ones that were never downloaded because they were too large.
     * Both end in the `failed` folder for a human to look at; Documents that did land stay landed.
     */
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
 * **Per-message failure returns; wholesale failure throws.** Anything that happens to *a message*
 * — a refused upload, unparseable MIME, a move that would not go through — is contained, counted
 * and reported in the summary, because the other messages in the batch are unaffected and the
 * scans that keep already-running Conversations moving have nothing to do with any of it.
 *
 * A failure *before the first message* is a different fact: the host is down, the password was
 * refused, the folder list could not be read. Nothing was attempted, so there is nothing to
 * summarise, and — the reason this is not swallowed here — the state that makes such a failure
 * bearable to read is "have I already said this?", which lives across polls and therefore in the
 * Watcher. Swallowing it here logged `ERROR the mail ingest failed` once a minute, for ever, and
 * left the Watcher's once-per-outage suppression as unreachable code. It leaves as a
 * {@link MailboxUnreachable}.
 */
export async function runMailIngest(deps: MailIngestDeps): Promise<MailIngestSummary> {
    const summary: MailIngestSummary = {
        fetched: 0,
        rejected: 0,
        created: 0,
        skipped: 0,
        failed: 0,
    };
    const { config, connector } = deps;

    // The default, and not an error: a household that has not set a mailbox up has no letterbox.
    // Checked before anything else so a disabled ingest opens no socket at all.
    if (config.host.trim() === "") return summary;

    try {
        // The switch in the web application, read every poll so turning it off stops the letterbox
        // without a restart. Before the session, so a switched-off ingest opens no socket at all.
        if (!(await isSwitchedOn(deps))) return summary;

        // ONE CONNECTION FOR THE WHOLE POLL. Everything that speaks IMAP happens in here, and the
        // socket is gone by the time this returns — see the file header for the arithmetic.
        await connector.session(async (session) => {
            // Up front rather than on demand: a missing `failed` label at the moment something
            // fails is the worst possible time to discover it. Existing folders are left alone.
            await session.ensureFolders([
                config.folderIncoming,
                config.folderProcessed,
                config.folderFailed,
                config.folderRejected,
            ]);

            const { messages, oversized, budgetExhausted } = await session.fetchBatch(
                config.folderIncoming,
                config.maxPerPoll,
            );

            // A poll that stopped short of `maxPerPoll` because it had spent its byte budget is a
            // normal, self-correcting event — the rest is still in `incoming` and the next poll
            // continues — but a silent one is baffling to anybody watching a backlog drain, so it
            // is said once per poll and at info rather than warn.
            if (budgetExhausted) {
                log.info("the letterbox poll spent its byte budget; the rest waits for the next poll", {
                    folder: config.folderIncoming,
                    fetched: messages.length,
                    maxPerPoll: config.maxPerPoll,
                });
            }

            // Before the ordinary messages, so that a folder whose head is a wall of undownloadable
            // mail is being cleared from the first poll rather than after the batch it is blocking.
            for (const message of oversized) {
                await fileOversized(deps, session, message, summary);
            }

            summary.fetched = messages.length;
            // `handleMessage` is total: every path inside it, including the move, ends in a log line
            // and a count rather than a throw. That is what makes one message's failure never abort
            // the batch, and it is why this loop needs no guard of its own — and why nothing it does
            // can be mistaken for the wholesale failure this `try` is here to catch.
            for (const message of messages) {
                await handleMessage(deps, session, message, summary);
            }
        });
    } catch (error) {
        // The mailbox as a whole: could not connect, could not authenticate, could not list the
        // folders, could not fetch. Wrapped rather than rethrown bare, so the Watcher's handler can
        // say what kind of failure it is holding.
        throw new MailboxUnreachable(error);
    }

    if (summary.fetched > 0 || summary.failed > 0) {
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
        if (off)
            log.debug("the mail ingest is switched off on its Operation Thing", {
                key: OPERATION_KEY,
            });
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
 * One message: decide what it turned out to be, then file it there.
 *
 * **Two steps, and the split is the correctness argument.** {@link classifyMessage} does all the
 * work and all the counting, and returns the folder the message belongs in. This function then
 * moves it — once, on every path, in a `try` of its own that swallows nothing but the move.
 *
 * The earlier shape had the move *inside* the catch-all, which quietly made the last statement of
 * a successful poll able to change its verdict. A transient IMAP error after every Document had
 * landed filed the message in `assistant/failed` — "tried, threw, gave up", a real inbox for a
 * human — and counted it `failed`, for a message that had entirely succeeded; and it did the same
 * to a rejected stranger, collapsing *"not for us"* into *"we broke"* and counting one message in
 * both `rejected` and `failed`. Neither is self-healing, because nothing ever reads those folders
 * again.
 *
 * What happens now when the move fails is nothing: the message stays in `incoming`, keeps the
 * outcome it earned, and is seen again next poll — where the `ExternalRef` query skips every
 * Document already created and the move is retried. A move failure is a log line and never an
 * ingest failure, because no ingesting failed.
 */
async function handleMessage(
    deps: MailIngestDeps,
    session: MailSession,
    fetched: FetchedMessage,
    summary: MailIngestSummary,
): Promise<void> {
    const { config } = deps;
    const destination = await classifyMessage(deps, fetched, summary);

    try {
        await session.move(fetched.uid, config.folderIncoming, destination);
    } catch (error) {
        log.error("a mail could not be moved out of the incoming folder; it stays there for the next poll", {
            uid: fetched.uid,
            destination,
            error: describeError(error),
        });
    }
}

/**
 * One message the fetch declined to download: say so loudly, and get it out of the way.
 *
 * There is nothing to classify — not one byte of the message was read, so neither the allowlist nor
 * the parser has anything to work with — and that is exactly why it cannot simply be left alone. A
 * message nobody downloads and nobody files is re-considered on every poll for ever, and since a
 * poll takes at most `maxPerPoll` candidates, a handful of them at the head of the folder quietly
 * starves the invoices behind them. So it goes to `failed`, the folder a human reads, and is counted
 * there: it is not a rejection (nobody said this sender may not write) and it is certainly not a
 * success.
 *
 * The size is the server's own `RFC822.SIZE`, logged next to the uid because "too large" without a
 * number is not something anybody can act on. The ceiling it exceeded belongs to the Connector,
 * which is what decides affordability; this file only files the consequence.
 *
 * Total, like {@link handleMessage}: a move that will not go through leaves the message where it is
 * for the next poll, which is the same self-healing behaviour every other move here has.
 */
async function fileOversized(
    deps: MailIngestDeps,
    session: MailSession,
    message: OversizedMessage,
    summary: MailIngestSummary,
): Promise<void> {
    const { config } = deps;
    summary.failed += 1;
    log.warn("a mail was too large to download; it belongs in the failed folder", {
        uid: message.uid,
        from: message.envelopeFrom,
        size: message.size,
        limit: "the connector's per-message download ceiling",
    });

    try {
        await session.move(message.uid, config.folderIncoming, config.folderFailed);
    } catch (error) {
        log.error("an oversized mail could not be moved out of the incoming folder; it stays there", {
            uid: message.uid,
            error: describeError(error),
        });
    }
}

/**
 * What did this message turn out to be? Returns the folder it belongs in, and never throws.
 *
 * Every counter the summary carries is incremented here, so "the outcome" and "where it is filed"
 * are one decision made in one place — and so the move, which cannot change any of it, cannot be
 * mistaken for part of it.
 */
async function classifyMessage(
    deps: MailIngestDeps,
    fetched: FetchedMessage,
    summary: MailIngestSummary,
): Promise<string> {
    const { config } = deps;
    try {
        // AUTHORISE FIRST, PARSE SECOND. The envelope address comes off the IMAP FETCH without any
        // MIME being touched, so a stranger's message is declined for the price of a string
        // comparison. The other order — which this had — fully parses the message first, which on a
        // full poll means up to `maxPerPoll` × `maxAttachmentBytes` of base64 decoded into this
        // process's memory on behalf of senders nobody vouched for. The mailbox is the first
        // untrusted input this system has, and the parser is the largest piece of foreign code it
        // reaches; the less of it a stranger can start, the better.
        if (!isAllowedSender(fetched.envelopeFrom, config.allowedSenders)) {
            reject(fetched.uid, fetched.envelopeFrom, summary);
            return config.folderRejected;
        }

        const message = await parseMessage(
            fetched.raw,
            fetched.uid,
            fetched.internalDate,
            config.maxAttachmentBytes,
            // WITHOUT THIS THE REF IS A COLLISION WAITING TO HAPPEN. A message whose sender omitted
            // the `Message-ID` is identified by its UID, and an IMAP UID is unique only within one
            // `(mailbox, UIDVALIDITY)` generation: recreate the `assistant` label and the server
            // starts at 1 again. The next such message then computes a ref an older, different
            // message already holds, the `ExternalRef` query below says "already landed", and the
            // invoice is skipped and filed in `processed` looking like a success.
            fetched.origin,
        );

        // BOTH must be allowed, and the second check is kept rather than replaced. The envelope
        // sender and the `From:` header are different facts — the envelope is who handed the message
        // to the server, the header is who the message claims to be from, and forging the second is
        // one line of SMTP. Whichever of the two a human had in mind when they added an address to
        // the allowlist, they did not mean "and the other one may be anybody". The check costs a
        // string comparison against a message that is already parsed.
        if (!isAllowedSender(message.from, config.allowedSenders)) {
            reject(fetched.uid, message.from, summary);
            return config.folderRejected;
        }

        for (const document of message.documents) {
            await ingestDocument(deps, message, document, summary);
        }

        return config.folderProcessed;
    } catch (error) {
        summary.failed += 1;
        log.error("a mail could not be ingested; it belongs in the failed folder", {
            uid: fetched.uid,
            error: describeError(error),
        });
        return config.folderFailed;
    }
}

/**
 * Count and log one refusal.
 *
 * Only the address is logged — the subject of a mail nobody vouched for is not worth putting in the
 * household's log, and after the envelope check there is not even a parsed subject to log.
 */
function reject(uid: number, from: string, summary: MailIngestSummary): void {
    log.info("a mail from a sender who is not on the allowlist was rejected", {
        uid,
        from,
    });
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
        log.debug("a Document for this mail is already in the store", {
            externalRef,
        });
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

    const extractedText = cappedText(await withTextLayer(document));

    await deps.things.create(DOCUMENT_WITH_ATTACHMENT, {
        title: capped(document.title, MAX_FIELD_LENGTH),
        // A Document with no `ReceivedAt` sorts nowhere and reads as if it never arrived. The
        // Connector always provides one; this is the belt for the day it cannot.
        receivedAt: storableInstant(document.receivedAt, deps.now?.() ?? new Date()),
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
 *   - **Arrival may not take the loop with it.** The decode is bounded at {@link ARRIVAL_MAX_PAGES}
 *     pages — a bound on *work*, distinct from {@link MAX_EXTRACTED_TEXT_LENGTH}'s bound on
 *     *payload* — and a read that was cut short says so in the text it returns.
 */
async function withTextLayer(document: IncomingDocument): Promise<string> {
    const attachment = document.attachment;
    if (!attachment || attachment.mimeType !== PDF_MEDIA_TYPE) return document.extractedText;
    if (document.extractedText.trim() !== "") return document.extractedText;

    try {
        const outcome = await readTextLayer(attachment.bytes, SPARSE_TEXT_CHARS, ARRIVAL_MAX_PAGES);
        if (outcome.kind === "text") {
            log.debug("read a forwarded PDF's text layer on arrival", {
                filename: attachment.filename,
                pages: outcome.pages,
                pagesRead: outcome.pagesRead,
                characters: outcome.text.length,
                // Reported, never acted on here: whether 84 characters are a parking receipt or a
                // scanner's leavings is the Receptionist's judgement, and it has the Document.
                sparse: outcome.sparse,
                truncated: outcome.truncated,
            });
            return outcome.truncated
                ? `${outcome.text}${pageTruncationNote(outcome.pagesRead, outcome.pages)}`
                : outcome.text;
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

/**
 * The Document's text, bounded — and told so, in the text itself.
 *
 * Unlike `Title` and `ExternalRef`, this is not capped because the store would refuse it: it is
 * capped because the Receptionist reads it on the very next Turn and pays per token for whatever
 * it finds. `capped()` cannot do this job: it ends with an ellipsis, which reads as an editorial
 * trailing-off rather than as a limit, and the note is the whole point.
 *
 * Kept whole when it fits, which is every ordinary invoice and every covering note anybody has
 * written. The note is appended *after* the cut, so a truncated Document is slightly over the
 * ceiling — deliberately: rounding the ceiling down to fit an explanation would be arithmetic
 * nobody could reconstruct from the stored value.
 */
function cappedText(value: string): string {
    if (value.length <= MAX_EXTRACTED_TEXT_LENGTH) return value;
    log.info("a mail's extracted text was longer than a Turn can afford; it was truncated", {
        characters: value.length,
        keptCharacters: MAX_EXTRACTED_TEXT_LENGTH,
    });
    return `${value.slice(0, MAX_EXTRACTED_TEXT_LENGTH)}${TRUNCATION_NOTE}`;
}

function capped(value: string, maxLength: number): string {
    return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

/** A12 `DateTimeType` is `yyyy-MM-dd'T'HH:mm:ss` — no milliseconds, no zone suffix. */
function isoStamp(date: Date): string {
    return date.toISOString().replace(/\.\d{3}Z$/, "");
}

/**
 * The instant a Document records, in the only spelling the store accepts.
 *
 * `Document_DM`'s `ReceivedAt` is a `DateTimeType` formatted `yyyy-MM-dd'T'HH:mm:ss` — **no
 * milliseconds and no zone suffix.** The Connector reports an ordinary ISO 8601 instant, which has
 * both, so passing it through unchanged is refused by the store with *"the given value is not valid
 * for type date representation"* and the message goes to the failed folder.
 *
 * That is exactly what happened on the first real email this system ever saw, and nothing caught it
 * earlier: every unit test writes through an in-memory store that does not validate the format, so
 * a suite of 383 tests was green over a Document that no A12 server would have accepted. The
 * normalisation existed — it was simply applied only to the fallback, and never to the value that
 * is used in practice.
 *
 * An unparseable instant falls back rather than throwing: a Document with no `ReceivedAt` sorts
 * nowhere and reads as if it never arrived, and the arrival time of the poll is a better answer
 * than losing the mail over a malformed `Date:` header.
 */
function storableInstant(value: string, fallback: Date): string {
    const parsed = value === "" ? undefined : new Date(value);
    return parsed !== undefined && !Number.isNaN(parsed.getTime())
        ? isoStamp(parsed)
        : isoStamp(fallback);
}
