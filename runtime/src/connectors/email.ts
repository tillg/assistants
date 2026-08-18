/**
 * The Email Connector — a mailbox over IMAP, and MIME turned into Documents.
 *
 * The file has two halves that never call each other, and that is the design rather than an
 * accident of layout:
 *
 *   1. **`parseMessage` is pure.** Bytes in, `IncomingMessage` out — no store, no clock, no socket.
 *      MIME is where the surprises live (encoded words, eight ways to spell a date, senders that
 *      omit the `Message-ID` entirely), so the part most likely to be wrong is the part that can be
 *      pinned to a fixture on disk and fixed without a mail server in the loop.
 *   2. **`EmailConnector` speaks IMAP and decides nothing.** It fetches, it moves, it creates
 *      folders. What is allowed, what is stored and what a failure means all live in the ingest
 *      above it, because those are decisions about the household and not about the protocol.
 *
 * Two rules from the architecture are load-bearing and easy to "tidy" away:
 *
 *   - **One Document per attachment, and every one of them carries the same body text.** A mail
 *     with two invoices attached is two invoices — they will be classified, booked and paid apart —
 *     but *"this is the dentist bill for Anna, I already paid it"* is context for both. Repeating
 *     the body is deliberate duplication, not a bug.
 *   - **An oversized attachment is skipped loudly.** Its name and size are appended to the text of
 *     whatever Documents the message does produce. A Document whose attachment silently vanished is
 *     worse than one that says why it is missing.
 *
 * `imapflow` and `mailparser` are used here and nowhere else in the Runtime, so replacing either —
 * or swapping IMAP for the Gmail API — is one file.
 */

import { simpleParser } from "mailparser";
import { ImapFlow } from "imapflow";

import { describeError, log } from "../log.js";

/** What a message with no readable subject and no attachment is called in the ThingStore. */
const NO_SUBJECT = "(no subject)";

export interface IncomingDocument {
    /** The subject; the attachment's filename when the subject is empty; otherwise `(no subject)`. */
    readonly title: string;
    /** ISO 8601, from the `Date` header — the server's INTERNALDATE when that is unusable. */
    readonly receivedAt: string;
    /**
     * `<message-id>#<part>` — the identity the ingest deduplicates on, and it must name the same
     * MIME part for ever.
     *
     * Three shapes, and the differences between them are load-bearing:
     *
     *   - `#0` — the message had **no attachment parts at all**. Body only.
     *   - `#N` (N ≥ 1) — the Nth part of the message's own attachment list, counted over *every*
     *     part the parser found, not over the ones that survived the size cap.
     *   - `#0.skipped` — the message *had* attachment parts and every one of them was over the cap.
     *     Deliberately not `#0`: see {@link parseMessage}.
     */
    readonly externalRef: string;
    /** The message body as prose. Identical across every Document one message produces. */
    readonly extractedText: string;
    readonly attachment?: {
        readonly filename: string;
        readonly mimeType: string;
        readonly size: number;
        readonly bytes: Buffer;
    };
}

export interface IncomingMessage {
    readonly uid: number;
    /** The envelope address, lowercased, display name stripped — what the allowlist is checked against. */
    readonly from: string;
    readonly subject: string;
    readonly documents: readonly IncomingDocument[];
}

/** The subset of a `mailparser` result this file uses. Everything else it returns is ignored. */
interface ParsedMail {
    subject?: string;
    messageId?: string;
    date?: Date;
    text?: string;
    html?: string | false;
    from?: { value?: Array<{ address?: string }> };
    attachments?: ParsedAttachment[];
}

interface ParsedAttachment {
    filename?: string;
    contentType?: string;
    contentDisposition?: string;
    content?: Buffer;
    size?: number;
}

/**
 * Where a message was found, in enough detail to tell one mailbox's UID 1 from another's.
 *
 * Only messages whose sender omitted the `Message-ID` need this, but for those it is the whole of
 * their identity. An IMAP UID is unique within one `(mailbox, UIDVALIDITY)` generation and nowhere
 * else: delete and recreate the `assistant` label and the server starts handing out UID 1 again.
 * Without the generation in the ref, the next `Message-ID`-less message computes an `ExternalRef`
 * that a completely different, older message already holds — and the ingest, doing exactly what it
 * is meant to do, treats the new invoice as a duplicate and files it away as `skipped`.
 *
 * `uidValidity` is a string because IMAP's is a 32-bit unsigned integer that `imapflow` hands over
 * as a `bigint`; the ref only ever compares it, never arithmetic on it.
 */
export interface MessageOrigin {
    /** The IMAP host the mailbox lives on. */
    readonly host: string;
    /** The folder (Gmail: label) the message was fetched from. */
    readonly folder: string;
    /** The folder's `UIDVALIDITY` at the moment of the fetch. */
    readonly uidValidity: string;
}

/**
 * Bytes to `IncomingMessage`. No network, no store, no side effects.
 *
 * `internalDate` is the server's own timestamp for the message, used only when the `Date` header is
 * missing or unparseable — which happens, and dropping the mail over it would be absurd.
 *
 * `origin` is only consulted for a message whose sender omitted the `Message-ID`; see
 * {@link MessageOrigin} for why leaving it out is a silently dropped invoice. It is optional purely
 * so that a caller that has no mailbox behind it (a fixture, a test) can still parse bytes — every
 * caller that *did* get the message off a server must pass it.
 */
export async function parseMessage(
    raw: Buffer,
    uid: number,
    internalDate: Date,
    maxAttachmentBytes: number,
    origin?: MessageOrigin,
): Promise<IncomingMessage> {
    const parsed = (await simpleParser(raw)) as ParsedMail;

    const subject = (parsed.subject ?? "").trim();
    const from = (parsed.from?.value?.[0]?.address ?? "").trim().toLowerCase();
    const messageId = (parsed.messageId ?? "").trim() || synthesiseMessageId(uid, origin);
    const receivedAt = usableDate(parsed.date) ?? internalDate.toISOString();

    const body = bodyText(parsed);
    const { kept, skipped } = partitionAttachments(parsed.attachments ?? [], maxAttachmentBytes);

    const extractedText = [body, ...skipped.map(describeSkipped)].filter((part) => part.length > 0).join("\n\n");

    if (skipped.length > 0) {
        log.warn("mail attachment over the size cap, skipped", {
            uid,
            messageId,
            files: skipped.map((attachment) => attachment.filename),
        });
    }

    // DO NOT "SIMPLIFY" THIS BACK TO `kept.map((_, index) => index + 1)`.
    //
    // The part number is an identity, not a position, and the cap is a setting the User changes.
    // Numbering the *kept* attachments means a mail carrying `big.pdf` (over the cap) and
    // `small.pdf` files `small.pdf` as `#1`. The User then raises `MAIL_MAX_ATTACHMENT_BYTES` and
    // replays the mail — which is precisely the reason the skip is loud — and now `big.pdf` is `#1`
    // and `small.pdf` is `#2`. The ingest sees `#1` already present and skips the invoice it was
    // replayed to collect, and creates a second copy of `small.pdf` under its new number. One lost
    // invoice, one duplicate, and a message moved to `processed` looking like a success.
    //
    // So each attachment is numbered by where it sits in the message's own part list, which no
    // setting of ours can move. Numbers may have gaps (an inline signature image is a part but not
    // an attachment) and that is fine: refs are compared, never counted.
    const documents: IncomingDocument[] =
        kept.length === 0
            ? [
                  {
                      title: subject || NO_SUBJECT,
                      receivedAt,
                      // `#0` means "no attachment parts at all", and a cap change can never make a
                      // message mean that. A message whose only attachment was skipped is a
                      // different case and gets a different ref: were it `#0` too, raising the cap
                      // would turn that ref into `#1` and the same mail would be ingested twice.
                      // `#0.skipped` is never produced at any other cap, so it collides with
                      // nothing — the placeholder Document simply stays alongside the real one.
                      externalRef: skipped.length === 0 ? `${messageId}#0` : `${messageId}#0.skipped`,
                      extractedText,
                  },
              ]
            : kept.map((attachment) => ({
                  // The filename joins the title as soon as one message becomes more than one
                  // Document, because otherwise they arrive indistinguishable.
                  //
                  // Measured: a real builder's invoice carried three PDFs — the invoice, the
                  // sender's letterhead logo and a Widerrufsbelehrung — and produced three Documents
                  // all titled "Fwd: Abschlagsrechnung RE0520 von A.H-Bau". In the overview that
                  // reads as the same thing filed three times, and the User's first conclusion was
                  // that deduplication was broken. It was not: the refs differ and a second poll
                  // creates nothing. Only the *title* collided, and a title is what a human
                  // identifies a Thing by.
                  //
                  // A single attachment keeps the bare subject: there is nothing to tell it apart
                  // from, and the subject is the more useful of the two.
                  title: titleFor(subject, attachment.filename, kept.length),
                  receivedAt,
                  externalRef: `${messageId}#${attachment.part}`,
                  extractedText,
                  attachment: attachment.attachment,
              }));

    return { uid, from, subject, documents };
}

/**
 * The `Message-ID` for a sender who did not send one.
 *
 * `<uid>@<mailbox-host>` is what the architecture asks for, and the mailbox is the whole point: a
 * UID means nothing without the `(folder, UIDVALIDITY)` generation it was issued in. Without those
 * two, a recreated label re-issues UID 1 and a brand-new invoice inherits an old message's ref.
 *
 * The value is derived only from things that are constant for a given message across polls — never
 * from a clock or a counter — because a ref that changes between polls defeats idempotency just as
 * thoroughly as one that collides.
 */
function synthesiseMessageId(uid: number, origin: MessageOrigin | undefined): string {
    if (!origin) {
        // Not fatal — parsing a fixture has no mailbox — but on the ingest path it is the
        // collision described above waiting to happen, so it is never allowed to be quiet.
        log.warn("synthesising a message id without a mailbox origin; refs are only unique per UID", { uid });
        return `<uid.${uid}@local>`;
    }
    return `<uid.${uid}.v${origin.uidValidity}.${refToken(origin.folder)}@${refToken(origin.host)}>`;
}

/** Folder and host names reach a ref as themselves; anything that is not addr-spec-safe becomes `-`. */
function refToken(value: string): string {
    const token = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
    return token.length > 0 ? token : "unknown";
}

/**
 * What a human will identify this Document by in a list of them.
 *
 * One attachment: the subject, which is what the mail is about. Several: the subject *and* the
 * filename, because three Documents sharing one title are indistinguishable in an overview however
 * different their contents are. No subject at all: the filename carries it alone.
 */
function titleFor(subject: string, filename: string, keptCount: number): string {
    if (subject === "") return filename || NO_SUBJECT;
    return keptCount > 1 ? `${subject} — ${filename}` : subject;
}

interface KeptAttachment {
    readonly filename: string;
    readonly mimeType: string;
    readonly size: number;
    readonly bytes: Buffer;
}

/**
 * An attachment together with its number — its 1-based position in the message's *whole* part list.
 *
 * The number is computed before the size cap is applied and is carried through it, which is the
 * entire point: the same MIME part must have the same number at every cap.
 */
interface NumberedAttachment {
    readonly part: number;
    readonly attachment: KeptAttachment;
    readonly filename: string;
    readonly size: number;
}

/**
 * Which MIME parts are attachments, and which of those fit.
 *
 * Anything with a filename or an explicit `attachment` disposition counts. An inline signature image
 * has neither — it is a logo, not an invoice — and is dropped here rather than becoming a Document
 * the Receptionist has to reason about. It still consumes a part number, so that whether the parser
 * hands us the logo or not, the invoice after it keeps its own number.
 */
function partitionAttachments(
    parts: ParsedAttachment[],
    maxAttachmentBytes: number,
): { kept: NumberedAttachment[]; skipped: NumberedAttachment[] } {
    const kept: NumberedAttachment[] = [];
    const skipped: NumberedAttachment[] = [];

    parts.forEach((part, index) => {
        const filename = (part.filename ?? "").trim();
        const disposition = (part.contentDisposition ?? "").toLowerCase();
        if (filename.length === 0 && disposition !== "attachment") return;

        const bytes = Buffer.isBuffer(part.content) ? part.content : Buffer.alloc(0);
        const attachment: KeptAttachment = {
            filename: filename || "attachment",
            mimeType: (part.contentType ?? "application/octet-stream").toLowerCase(),
            size: bytes.length,
            bytes,
        };
        const numbered: NumberedAttachment = {
            // The position in the parsed part list, which the cap has no say over.
            part: index + 1,
            attachment,
            filename: attachment.filename,
            size: attachment.size,
        };
        (attachment.size > maxAttachmentBytes ? skipped : kept).push(numbered);
    });

    return { kept, skipped };
}

function describeSkipped(attachment: NumberedAttachment): string {
    return `[Attachment "${attachment.filename}" (${attachment.size} bytes) was too large to store and has been skipped.]`;
}

/**
 * The body as prose: `text/plain` when the sender provided it, otherwise the HTML stripped.
 *
 * `ExtractedText` is read by an LLM. Markup is noise it pays tokens for, and no downstream step
 * renders it.
 */
function bodyText(parsed: ParsedMail): string {
    const text = (parsed.text ?? "").trim();
    if (text.length > 0) return text;
    return typeof parsed.html === "string" ? stripHtml(parsed.html) : "";
}

/**
 * Enough HTML-to-text for a mail body — not a renderer, and deliberately not one.
 *
 * Billing mail is tables and paragraphs; what matters is that the words survive, that block
 * boundaries become line breaks rather than running two sentences together, and that no script or
 * style content reaches the model.
 */
function stripHtml(html: string): string {
    return html
        .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/g, "'")
        .replace(/[ \t]+/g, " ")
        .replace(/ *\n *(\n *)+/g, "\n\n")
        .replace(/ *\n */g, "\n")
        .trim();
}

function usableDate(date: Date | undefined): string | undefined {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return undefined;
    return date.toISOString();
}

// ---------------------------------------------------------------------------------------------
// The IMAP half. Everything below here needs a mail server; everything above it does not.
// ---------------------------------------------------------------------------------------------

export interface MailboxOptions {
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly password: string;
    /** Implicit TLS. Defaults to `true`; only the integration tier's throwaway server sets it false. */
    readonly secure?: boolean;
}

export interface FetchedMessage {
    readonly uid: number;
    readonly raw: Buffer;
    readonly internalDate: Date;
    /**
     * The envelope sender, lowercased and stripped to the bare address — `""` when the server sent
     * no envelope or an envelope with no from-address.
     *
     * It is here, rather than only on the parsed message, so the ingest can decide *whether it wants
     * this mail at all* before a single byte of MIME is decoded. IMAP hands the envelope over in the
     * same FETCH as the source, so it costs nothing; what it buys is that a stranger's attachments
     * are never base64-decoded into this process's memory on the strength of an address nobody
     * vouched for.
     */
    readonly envelopeFrom: string;
    /**
     * The mailbox generation this UID was issued in, threaded through to `parseMessage` so a
     * `Message-ID`-less message gets a ref that a recreated label cannot re-issue.
     *
     * Optional only because a `FetchedMessage` can be built by hand in a test; anything that came
     * off a real server always carries it.
     */
    readonly origin?: MessageOrigin;
}

/** One message left on the server because downloading it would not have been affordable. */
export interface OversizedMessage {
    readonly uid: number;
    /** `RFC822.SIZE` — the size the server reported, without a byte of it being downloaded. */
    readonly size: number;
    readonly envelopeFrom: string;
}

/**
 * What one poll of a folder actually yielded, including what it deliberately did not.
 *
 * `oversized` is not a detail for a log line. A message that `fetch` silently declines to download
 * stays in `incoming` and is declined again every minute for ever, so the caller has to be told
 * about it in order to move it out to `failed`. Anything that drops this array reinvents a poll
 * that never makes progress.
 */
export interface FetchResult {
    readonly messages: FetchedMessage[];
    readonly oversized: OversizedMessage[];
    /**
     * True when the poll's byte budget, not `max`, ended the batch. Nothing was lost — the
     * remaining messages are still in `incoming` and the next poll starts with them — but it is the
     * signal that the mailbox is arriving faster than it is being drained.
     */
    readonly budgetExhausted: boolean;
}

/**
 * What a single poll may spend, in bytes on the wire and in memory.
 *
 * These live on the fetch call rather than on `MailboxOptions` because they belong with `max`: all
 * three bound *one poll*, whereas `MailboxOptions` describes the connection, which is a different
 * lifetime and a different question.
 */
export interface FetchLimits {
    /** Above this, a single message is not downloaded at all. Default {@link DEFAULT_MAX_MESSAGE_BYTES}. */
    readonly maxMessageBytes?: number;
    /** Total raw bytes one poll may accumulate. Default {@link DEFAULT_MAX_TOTAL_BYTES}. */
    readonly maxTotalBytes?: number;
}

/**
 * 40 MiB — a message at Gmail's 25 MiB attachment ceiling, base64 expanded (×4/3) plus headers,
 * still comes down. Anything above it is not a household invoice and will not become one.
 */
const DEFAULT_MAX_MESSAGE_BYTES = 40 * 1024 * 1024;

/**
 * 64 MiB of raw source per poll.
 *
 * The number that has to be bounded is not the attachment cap — that is applied *after* mailparser
 * has already decoded everything — but the raw bytes this single-threaded loop holds and then
 * parses. At `MAIL_MAX_PER_POLL=20` with no budget, a spam batch of maximum-size messages is ~700 MB
 * of buffers and minutes of synchronous parsing, in the same loop that runs the ThingStore scans and
 * that `health.ts` calls stale after 90 seconds. A spam batch must not make the Runtime unhealthy.
 */
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/**
 * The three mailbox operations, on a connection somebody else is holding open.
 *
 * This is the same surface as {@link EmailConnector}; the difference is only who owns the socket.
 */
export interface MailSession {
    fetch(folder: string, max: number, limits?: FetchLimits): Promise<FetchedMessage[]>;
    fetchBatch(folder: string, max: number, limits?: FetchLimits): Promise<FetchResult>;
    move(uid: number, fromFolder: string, toFolder: string): Promise<void>;
    ensureFolders(folders: readonly string[]): Promise<void>;
}

/**
 * A mailbox.
 *
 * Each method still connects, works and closes, so no caller had to change and nothing holds a
 * socket across the minute between polls — a socket held that long has to survive a provider's idle
 * timeout, a container pause and a network blip for no gain.
 *
 * But *within* one poll that arithmetic is the other way round. A poll is `ensureFolders` + `fetch`
 * + one `move` per message, and with a method-per-connection that is 22 TLS handshakes and 22 IMAP
 * logins a minute at `maxPerPoll=20` — against a provider that throttles rapid reconnects, with all
 * of that latency sitting inside the scan loop. {@link session} therefore lends one connection to a
 * block of work; the standalone methods are that same block with exactly one operation in it.
 *
 * TLS is implicit and certificate verification is never disabled. There is no option to turn it off,
 * because the moment one exists someone sets it.
 */
export class EmailConnector {
    constructor(private readonly options: MailboxOptions) {}

    private client(): ImapFlow {
        return new ImapFlow({
            host: this.options.host,
            port: this.options.port,
            secure: this.options.secure ?? true,
            auth: { user: this.options.user, pass: this.options.password },
            // imapflow's own protocol chatter is far too loud for a household service.
            logger: false,
        });
    }

    /**
     * Run `work` against one connection, opened before it and closed after it.
     *
     * The whole of a poll belongs in here. Nothing about the session outlives the call, so a
     * connection that dies mid-poll fails that poll and the next one starts fresh a minute later —
     * which is the same failure mode as before, at a twenty-second of the handshakes.
     */
    async session<T>(work: (session: MailSession) => Promise<T>): Promise<T> {
        const client = this.client();
        await client.connect();
        try {
            return await work(new ConnectedSession(client, this.options.host));
        } finally {
            try {
                await client.logout();
            } catch (error) {
                // The work is already done or already failed; a rude disconnect must not mask it.
                log.debug("IMAP logout failed", { error: describeError(error) });
            }
        }
    }

    /**
     * Every message in `folder`, oldest first, capped at `max` and at a byte budget.
     *
     * Messages left behind for size are dropped on the floor by this signature — use
     * {@link fetchBatch} on the ingest path, where an undownloadable message has to be moved out of
     * `incoming` or it is retried for ever.
     */
    async fetch(folder: string, max: number, limits?: FetchLimits): Promise<FetchedMessage[]> {
        return this.session((session) => session.fetch(folder, max, limits));
    }

    /** {@link fetch}, and what it decided not to fetch. */
    async fetchBatch(folder: string, max: number, limits?: FetchLimits): Promise<FetchResult> {
        return this.session((session) => session.fetchBatch(folder, max, limits));
    }

    /**
     * Move one message between folders, creating the destination if it is missing.
     *
     * Creating it here rather than at startup matters: a missing `failed` label at the moment
     * something fails is the worst possible time to discover it.
     */
    async move(uid: number, fromFolder: string, toFolder: string): Promise<void> {
        await this.session((session) => session.move(uid, fromFolder, toFolder));
    }

    /** Create any of `folders` that do not exist yet. Existing ones are left alone. */
    async ensureFolders(folders: readonly string[]): Promise<void> {
        await this.session((session) => session.ensureFolders(folders));
    }
}

/** The mailbox operations, bound to one already-connected client. */
class ConnectedSession implements MailSession {
    constructor(
        private readonly client: ImapFlow,
        private readonly host: string,
    ) {}

    async fetch(folder: string, max: number, limits?: FetchLimits): Promise<FetchedMessage[]> {
        return (await this.fetchBatch(folder, max, limits)).messages;
    }

    /**
     * Two passes, and the order of them is the fix.
     *
     * The first pass asks only for `RFC822.SIZE`, the envelope and the internal date — metadata, no
     * bodies — so the poll learns what every candidate message *would* cost before it costs
     * anything. Only then does the second pass download sources, and only for the messages that fit
     * inside `maxMessageBytes` individually and `maxTotalBytes` together.
     *
     * The old single pass buffered every source first and applied the attachment cap afterwards, by
     * which time mailparser had already decoded a 30 MB attachment against a 1 MB cap — measured at
     * 9.4 seconds and +255 MB rss — in order to throw it away. A cap that is only enforced after the
     * work it was meant to prevent is not a cap.
     *
     * `max` still bounds the message count; the budget bounds the bytes, which is the quantity that
     * actually stalls the loop.
     */
    async fetchBatch(folder: string, max: number, limits: FetchLimits = {}): Promise<FetchResult> {
        const maxMessageBytes = limits.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
        const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

        const lock = await this.client.getMailboxLock(folder);
        try {
            const mailbox = this.client.mailbox;
            const origin: MessageOrigin = {
                host: this.host,
                folder,
                uidValidity: mailbox ? String(mailbox.uidValidity) : "0",
            };

            // PASS ONE: metadata only. Nothing here downloads a body.
            const candidates: MessageMetadata[] = [];
            for await (const message of this.client.fetch("1:*", {
                uid: true,
                // RFC822.SIZE — what the second pass is about to be asked to pay.
                size: true,
                internalDate: true,
                // The envelope is what lets the ingest reject a stranger before parsing him.
                envelope: true,
            })) {
                candidates.push({
                    uid: message.uid,
                    size: message.size ?? 0,
                    envelopeFrom: envelopeAddress(message.envelope),
                    // Servers spell INTERNALDATE in several ways; imapflow hands back either a
                    // Date or the raw string, and only one of those is usable downstream.
                    internalDate:
                        message.internalDate instanceof Date
                            ? message.internalDate
                            : new Date(message.internalDate ?? Date.now()),
                });
                if (candidates.length >= max) break;
            }

            // WHAT TO PAY FOR. Decided entirely on the server's own numbers.
            const { wanted, oversized, budgetExhausted } = planFetch(candidates, {
                maxMessageBytes,
                maxTotalBytes,
            });

            if (oversized.length > 0) {
                log.warn("mail too large to download, left on the server", {
                    folder,
                    uids: oversized.map((message) => message.uid),
                    maxMessageBytes,
                });
            }
            if (budgetExhausted) {
                log.info("the poll's byte budget was reached; the rest waits for the next poll", {
                    folder,
                    fetched: wanted.length,
                    ofCandidates: candidates.length,
                    maxTotalBytes,
                });
            }

            // PASS TWO: the sources, one at a time, for the messages already known to be affordable.
            const messages: FetchedMessage[] = [];
            for (const candidate of wanted) {
                const fetched = await this.client.fetchOne(
                    String(candidate.uid),
                    { uid: true, source: true },
                    { uid: true },
                );
                // Between the passes the message may have been moved or deleted by somebody else.
                // Not an error: it is simply no longer in this folder.
                if (!fetched) continue;
                messages.push({
                    uid: candidate.uid,
                    envelopeFrom: candidate.envelopeFrom,
                    internalDate: candidate.internalDate,
                    origin,
                    raw: Buffer.isBuffer(fetched.source) ? fetched.source : Buffer.from(fetched.source ?? ""),
                });
            }

            return { messages, oversized, budgetExhausted };
        } finally {
            lock.release();
        }
    }

    async move(uid: number, fromFolder: string, toFolder: string): Promise<void> {
        await createFolder(this.client, toFolder);
        const lock = await this.client.getMailboxLock(fromFolder);
        try {
            await this.client.messageMove(String(uid), toFolder, { uid: true });
        } finally {
            lock.release();
        }
    }

    async ensureFolders(folders: readonly string[]): Promise<void> {
        for (const folder of folders) await createFolder(this.client, folder);
    }
}

/** A message as the first pass knows it: everything except the bytes. */
export interface MessageMetadata {
    readonly uid: number;
    /** `RFC822.SIZE`, as reported by the server. */
    readonly size: number;
    readonly envelopeFrom: string;
    readonly internalDate: Date;
}

/**
 * Which of the candidate messages this poll will actually download.
 *
 * Split out and exported because it is the whole of the size decision and it is pure: whether a
 * mailbox full of maximum-size spam can stall the Runtime past `health.ts`'s 90-second staleness
 * threshold is decided here, and that deserves a test that does not need an IMAP server.
 *
 * Exported for the tests; nothing outside this file calls it.
 */
export function planFetch(
    candidates: readonly MessageMetadata[],
    limits: { maxMessageBytes: number; maxTotalBytes: number },
): { wanted: MessageMetadata[]; oversized: OversizedMessage[]; budgetExhausted: boolean } {
    const wanted: MessageMetadata[] = [];
    const oversized: OversizedMessage[] = [];
    let budget = 0;
    let budgetExhausted = false;

    for (const candidate of candidates) {
        if (candidate.size > limits.maxMessageBytes) {
            // Left on the server, and named in the result: a message nobody downloads and nobody
            // hears about is retried every minute until the mailbox is cleaned out by hand.
            oversized.push({ uid: candidate.uid, size: candidate.size, envelopeFrom: candidate.envelopeFrom });
            continue;
        }
        // The first affordable message is always taken, however large, or a folder whose oldest
        // message exceeds the whole budget never drains at all.
        if (wanted.length > 0 && budget + candidate.size > limits.maxTotalBytes) {
            budgetExhausted = true;
            break;
        }
        budget += candidate.size;
        wanted.push(candidate);
    }

    return { wanted, oversized, budgetExhausted };
}

/**
 * The envelope's first from-address, normalised the way `parseMessage` normalises the header one.
 *
 * The same normalisation on both sides is the point: the ingest compares the envelope address and
 * the parsed `From:` against one allowlist, and a gate whose two halves disagree about what an
 * address *is* is not a gate. A missing envelope, an empty `from` list or an address-less entry all
 * become `""`, which the allowlist refuses — an absent sender is never an allowed one.
 *
 * Exported so the normalisation the allowlist depends on can be pinned to a test without an IMAP
 * server in the loop; nothing outside this file calls it.
 */
export function envelopeAddress(envelope: { from?: Array<{ address?: string }> } | undefined): string {
    return (envelope?.from?.[0]?.address ?? "").trim().toLowerCase();
}

/**
 * `CREATE`, treating "it is already there" as success.
 *
 * There is no reliable machine-readable code for it across providers, so the failure is swallowed
 * and logged rather than parsed: the next operation on the folder fails loudly if the create really
 * did not happen, and that is a better signal than a string match on a server's prose.
 */
async function createFolder(client: ImapFlow, folder: string): Promise<void> {
    try {
        await client.mailboxCreate(folder);
        log.info("created mail folder", { folder });
    } catch (error) {
        log.debug("mail folder not created (it most likely exists)", {
            folder,
            error: describeError(error),
        });
    }
}
