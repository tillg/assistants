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
    /** `<message-id>#<part>`. Part 0 means "the body, with nothing attached". */
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
 * Bytes to `IncomingMessage`. No network, no store, no side effects.
 *
 * `internalDate` is the server's own timestamp for the message, used only when the `Date` header is
 * missing or unparseable — which happens, and dropping the mail over it would be absurd.
 */
export async function parseMessage(
    raw: Buffer,
    uid: number,
    internalDate: Date,
    maxAttachmentBytes: number,
): Promise<IncomingMessage> {
    const parsed = (await simpleParser(raw)) as ParsedMail;

    const subject = (parsed.subject ?? "").trim();
    const from = (parsed.from?.value?.[0]?.address ?? "").trim().toLowerCase();
    // A UID is stable within a mailbox, which is all idempotency needs; the alternative to
    // synthesising one is losing the mail because its sender is non-conformant.
    const messageId = (parsed.messageId ?? "").trim() || `<uid.${uid}@local>`;
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

    const documents: IncomingDocument[] =
        kept.length === 0
            ? [
                  {
                      title: subject || NO_SUBJECT,
                      receivedAt,
                      externalRef: `${messageId}#0`,
                      extractedText,
                  },
              ]
            : kept.map((attachment, index) => ({
                  title: subject || attachment.filename,
                  receivedAt,
                  externalRef: `${messageId}#${index + 1}`,
                  extractedText,
                  attachment,
              }));

    return { uid, from, subject, documents };
}

interface KeptAttachment {
    readonly filename: string;
    readonly mimeType: string;
    readonly size: number;
    readonly bytes: Buffer;
}

/**
 * Which MIME parts are attachments, and which of those fit.
 *
 * Anything with a filename or an explicit `attachment` disposition counts. An inline signature image
 * has neither — it is a logo, not an invoice — and is dropped here rather than becoming a Document
 * the Receptionist has to reason about.
 */
function partitionAttachments(
    parts: ParsedAttachment[],
    maxAttachmentBytes: number,
): { kept: KeptAttachment[]; skipped: KeptAttachment[] } {
    const kept: KeptAttachment[] = [];
    const skipped: KeptAttachment[] = [];

    for (const part of parts) {
        const filename = (part.filename ?? "").trim();
        const disposition = (part.contentDisposition ?? "").toLowerCase();
        if (filename.length === 0 && disposition !== "attachment") continue;

        const bytes = Buffer.isBuffer(part.content) ? part.content : Buffer.alloc(0);
        const attachment: KeptAttachment = {
            filename: filename || "attachment",
            mimeType: (part.contentType ?? "application/octet-stream").toLowerCase(),
            size: bytes.length,
            bytes,
        };
        (attachment.size > maxAttachmentBytes ? skipped : kept).push(attachment);
    }

    return { kept, skipped };
}

function describeSkipped(attachment: KeptAttachment): string {
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
}

/**
 * A mailbox, opened per operation.
 *
 * There is no connection pool and no long-lived session on purpose: the ingest polls once a minute,
 * so a socket held open between polls is a socket that has to survive a provider's idle timeout, a
 * container pause and a network blip — for no gain over logging in again. Every method therefore
 * connects, does its work, and closes in a `finally`.
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
            secure: true,
            auth: { user: this.options.user, pass: this.options.password },
            // imapflow's own protocol chatter is far too loud for a household service.
            logger: false,
        });
    }

    private async withClient<T>(work: (client: ImapFlow) => Promise<T>): Promise<T> {
        const client = this.client();
        await client.connect();
        try {
            return await work(client);
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
     * Every message in `folder`, oldest first, capped at `max`.
     *
     * The cap is what keeps one poll bounded: a mailbox that has accumulated a thousand messages
     * must not turn a scan into a ten-minute stall of the loop that also keeps Conversations moving.
     * The rest are still there next poll.
     */
    async fetch(folder: string, max: number): Promise<FetchedMessage[]> {
        return this.withClient(async (client) => {
            const lock = await client.getMailboxLock(folder);
            try {
                const messages: FetchedMessage[] = [];
                for await (const message of client.fetch("1:*", {
                    uid: true,
                    source: true,
                    internalDate: true,
                    // The envelope is what lets the ingest reject a stranger before parsing him.
                    envelope: true,
                })) {
                    messages.push({
                        uid: message.uid,
                        envelopeFrom: envelopeAddress(message.envelope),
                        raw: Buffer.isBuffer(message.source) ? message.source : Buffer.from(message.source ?? ""),
                        // Servers spell INTERNALDATE in several ways; imapflow hands back either a
                        // Date or the raw string, and only one of those is usable downstream.
                        internalDate:
                            message.internalDate instanceof Date
                                ? message.internalDate
                                : new Date(message.internalDate ?? Date.now()),
                    });
                    if (messages.length >= max) break;
                }
                return messages;
            } finally {
                lock.release();
            }
        });
    }

    /**
     * Move one message between folders, creating the destination if it is missing.
     *
     * Creating it here rather than at startup matters: a missing `failed` label at the moment
     * something fails is the worst possible time to discover it.
     */
    async move(uid: number, fromFolder: string, toFolder: string): Promise<void> {
        await this.withClient(async (client) => {
            await createFolder(client, toFolder);
            const lock = await client.getMailboxLock(fromFolder);
            try {
                await client.messageMove(String(uid), toFolder, { uid: true });
            } finally {
                lock.release();
            }
        });
    }

    /** Create any of `folders` that do not exist yet. Existing ones are left alone. */
    async ensureFolders(folders: readonly string[]): Promise<void> {
        await this.withClient(async (client) => {
            for (const folder of folders) await createFolder(client, folder);
        });
    }
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
