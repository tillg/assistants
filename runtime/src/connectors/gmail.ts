/**
 * The Gmail Connector — the same letterbox, reached over Gmail's REST API instead of IMAP.
 *
 * **Why this file exists at all.** The household has a working OAuth grant for its Gmail account —
 * the sibling `wikai` project already uses it through the `gog` CLI, so a Google Cloud OAuth app, a
 * completed consent flow and a refresh token all exist. What it does not have, and does not want, is
 * a Google **App Password**: those require 2FA on the account. Gmail's IMAP endpoint needs the
 * `https://mail.google.com/` scope, which that grant does not carry — XOAUTH2 login against it is
 * refused, verified — so IMAP is a dead end for this household however the credentials are spelled.
 * The Gmail API is the way in, and the setup cost that once made it the rejected alternative has
 * already been paid by another project.
 *
 * **Nothing above this file knows.** {@link GmailConnector} presents exactly the surface
 * {@link EmailConnector} does — `session()` handing over a {@link MailSession} of `fetchBatch`,
 * `move` and `ensureFolders` — so `watcher/mail.ts` is unchanged and unaware. The byte-budget
 * decision is not reimplemented either: the candidates go through `email.ts`'s exported
 * {@link planFetch}, which is the whole of the affordability rule and is now shared by both
 * transports rather than copied into one of them.
 *
 * **Three things about Gmail's API are load-bearing and easy to get wrong:**
 *
 *   1. **Labels are folders, and the API wants label *ids*.** `assistants/processed` is a name a
 *      human reads; `Label_6810297171539270188` is what `modify` accepts. The name→id map is
 *      resolved once per session and cached, and missing labels are created — Gmail builds the
 *      `/`-nested hierarchy itself.
 *   2. **List *messages*, never *threads*.** `wikai`'s ingest skill documents the trap from its own
 *      account: a thread search returns threads, and the label may sit on a message that is not the
 *      first one in its thread, so a forwarded invoice buried in a reply chain is silently missed.
 *      `messages.list` sidesteps it entirely because the label is matched against the message. Do
 *      not "optimise" this back into `threads.list` + `threads.get`.
 *   3. **A Gmail message id is a hex string; `FetchedMessage.uid` is a `number`.** See
 *      {@link numericUid} — the resolution is not a cast, and it cannot be, because that id has to
 *      survive into the `Message-ID` `parseMessage` synthesises for senders who omit one.
 *
 * `fetch` is the only I/O primitive used here, injectable for the tests, and no token is ever
 * logged.
 */

import { createHash } from "node:crypto";

import { log } from "../log.js";
import {
    envelopeAddress,
    planFetch,
    type FetchLimits,
    type FetchResult,
    type FetchedMessage,
    type MailSession,
    type MessageMetadata,
    type MessageOrigin,
    type OversizedMessage,
} from "./email.js";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** No outbound call may hang the scan loop. Generous, because a `format=raw` fetch is megabytes. */
const REQUEST_TIMEOUT_MS = 60_000;

/** Refresh a minute early rather than discover the expiry as a 401 on every call in a batch. */
const TOKEN_SKEW_MS = 60_000;

/**
 * The two byte ceilings, mirroring `email.ts`'s own defaults.
 *
 * They are copied rather than imported because `email.ts` does not export them and this change does
 * not own that file. Both transports must agree on what a poll may spend — see `email.ts` for the
 * reasoning behind the numbers, which is about this process's memory and `health.ts`'s ninety-second
 * staleness threshold, and is not specific to a protocol.
 */
const DEFAULT_MAX_MESSAGE_BYTES = 40 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/**
 * What {@link MessageOrigin.host} says for every message this Connector produces.
 *
 * A synthesised `Message-ID` embeds it, so it is part of an identity that must never change:
 * "gmail" is the transport, it is stable, and it distinguishes these refs from any produced against
 * an IMAP host of the same account.
 */
const ORIGIN_HOST = "gmail";

export interface GmailOptions {
    /**
     * The mailbox, used as the API's `userId`. Empty means `me` — the account the refresh token was
     * granted for, which is the same mailbox in every deployment anybody has. Naming it explicitly
     * turns a credential/account mismatch into a 403 at the first poll rather than a silent read of
     * whichever mailbox the grant happened to belong to.
     */
    readonly user: string;
    readonly clientId: string;
    readonly clientSecret: string;
    /** The long-lived half of the grant. Never logged, never included in an error message. */
    readonly refreshToken: string;
    /** Injected by the tests; nothing in production passes it. */
    readonly fetchImpl?: typeof fetch;
}

/**
 * A Gmail mailbox.
 *
 * Deliberately the same shape as `EmailConnector`, including `session()`, even though HTTP holds no
 * socket to lend: what a session buys here is a *cache*. One poll resolves the four label ids once
 * and remembers which numeric uid stands for which Gmail id, instead of doing both again for every
 * message it moves.
 */
export class GmailConnector {
    private readonly http: GmailHttp;

    constructor(options: GmailOptions) {
        this.http = new GmailHttp(options);
    }

    /**
     * Run `work` against one label cache.
     *
     * Nothing about the session outlives the call, which matters for the same reason it does over
     * IMAP: a label the User renames between polls must not be remembered for ever.
     */
    async session<T>(work: (session: MailSession) => Promise<T>): Promise<T> {
        return work(new GmailSession(this.http));
    }

    /** Every message under `folder`'s label, capped at `max` and at a byte budget. */
    async fetch(folder: string, max: number, limits?: FetchLimits): Promise<FetchedMessage[]> {
        return this.session((session) => session.fetch(folder, max, limits));
    }

    /** {@link fetch}, and what it decided not to fetch. */
    async fetchBatch(folder: string, max: number, limits?: FetchLimits): Promise<FetchResult> {
        return this.session((session) => session.fetchBatch(folder, max, limits));
    }

    /**
     * Move one message between labels.
     *
     * Only meaningful inside the session that fetched it: `uid` is derived from a Gmail id (see
     * {@link numericUid}) and the mapping back lives in that session. The ingest always moves inside
     * the poll that fetched, so this standalone form exists for symmetry with `EmailConnector` and
     * throws rather than guessing.
     */
    async move(uid: number, fromFolder: string, toFolder: string): Promise<void> {
        await this.session((session) => session.move(uid, fromFolder, toFolder));
    }

    /** Create any of `folders` that do not exist yet as labels. Existing ones are left alone. */
    async ensureFolders(folders: readonly string[]): Promise<void> {
        await this.session((session) => session.ensureFolders(folders));
    }
}

/** The Gmail operations, bound to one session's label cache. */
class GmailSession implements MailSession {
    /** Label name → label id, for this session only. Empty until something needs it. */
    private readonly labelIds = new Map<string, string>();
    private labelsListed = false;
    /** The numeric uid handed upward → the Gmail id it stands for. Filled by pass one. */
    private readonly gmailIds = new Map<number, string>();

    constructor(private readonly http: GmailHttp) {}

    async fetch(folder: string, max: number, limits?: FetchLimits): Promise<FetchedMessage[]> {
        return (await this.fetchBatch(folder, max, limits)).messages;
    }

    /**
     * Two passes, for the same reason `email.ts` has two.
     *
     * The first asks for metadata only — `sizeEstimate`, `internalDate`, and the single `From`
     * header — so the poll learns what each candidate *would* cost, and learns who sent it, before a
     * byte of body is downloaded. `format=metadata&metadataHeaders=From` is one request that answers
     * all three: the envelope gate in the ingest runs against a message whose MIME has not been
     * touched, which is the security property the ordering exists for.
     *
     * The second downloads `format=raw` for exactly the messages {@link planFetch} approved.
     *
     * `sizeEstimate` is Gmail's word: an *estimate* of the RFC822 size, where IMAP's `RFC822.SIZE`
     * is exact. The budget is therefore approximate at its edges, which is fine — it exists to stop
     * a mailbox of maximum-size spam stalling the scan loop, not to account for bytes.
     */
    async fetchBatch(folder: string, max: number, limits: FetchLimits = {}): Promise<FetchResult> {
        const maxMessageBytes = limits.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
        const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

        const labelId = await this.labelId(folder, false);
        if (labelId === undefined) {
            // The label does not exist yet, which is what an untouched account looks like. Nothing
            // to read, and not an error: `ensureFolders` creates it on the same poll.
            return { messages: [], oversized: [], budgetExhausted: false };
        }

        const ids = await this.listMessageIds(labelId, max);

        // PASS ONE: metadata only. Nothing here downloads a body.
        const candidates: MessageMetadata[] = [];
        for (const id of ids) {
            const metadata = await this.http.json<GmailMessage>(
                `/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From`,
            );
            const uid = numericUid(id);
            this.gmailIds.set(uid, id);
            candidates.push({
                uid,
                size: metadata.sizeEstimate ?? 0,
                envelopeFrom: headerAddress(metadata.payload?.headers, "From"),
                // `internalDate` is epoch milliseconds — as a *string*, because the API is JSON and
                // the value does not fit a double safely as anything Google is willing to promise.
                internalDate: new Date(Number(metadata.internalDate ?? Date.now())),
            });
        }

        // Oldest first, so a backlog drains in the order it arrived. `messages.list` returns newest
        // first; every message leaves the incoming label whatever happens to it, so the label
        // shrinks by a poll's worth each time either way — the ordering is about which invoice a
        // human sees appear first, not about progress.
        candidates.sort((a, b) => a.internalDate.getTime() - b.internalDate.getTime());

        // WHAT TO PAY FOR. `email.ts`'s decision, shared rather than reimplemented.
        const { wanted, oversized, budgetExhausted } = planFetch(candidates, {
            maxMessageBytes,
            maxTotalBytes,
        });

        if (oversized.length > 0) {
            log.warn("mail too large to download, left in Gmail", {
                folder,
                uids: oversized.map((message: OversizedMessage) => message.uid),
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

        const origin: MessageOrigin = { host: ORIGIN_HOST, folder, uidValidity: "" };

        // PASS TWO: the sources, for messages already known to be affordable.
        const messages: FetchedMessage[] = [];
        for (const candidate of wanted) {
            const id = this.gmailIds.get(candidate.uid) ?? "";
            const raw = await this.http.json<GmailMessage>(`/messages/${encodeURIComponent(id)}?format=raw`);
            if (raw.raw === undefined) continue;
            messages.push({
                uid: candidate.uid,
                envelopeFrom: candidate.envelopeFrom,
                internalDate: candidate.internalDate,
                // The Gmail id, not a generation counter — see {@link originGeneration}.
                origin: { ...origin, uidValidity: originGeneration(id) },
                // `format=raw` is base64url, not base64: `-` and `_` for `+` and `/`.
                raw: Buffer.from(raw.raw, "base64url"),
            });
        }

        return { messages, oversized, budgetExhausted };
    }

    /**
     * `modify` with one label added and one removed — Gmail's whole notion of a move.
     *
     * The destination is created if it is missing, exactly as the IMAP connector does and for the
     * same reason: a missing `failed` label at the moment something fails is the worst possible
     * time to discover it.
     */
    async move(uid: number, fromFolder: string, toFolder: string): Promise<void> {
        const id = this.gmailIds.get(uid);
        if (id === undefined) {
            throw new Error(`no Gmail message is known for uid ${uid} in this session`);
        }
        const from = await this.labelId(fromFolder, true);
        const to = await this.labelId(toFolder, true);
        await this.http.json<unknown>(`/messages/${encodeURIComponent(id)}/modify`, {
            method: "POST",
            body: { addLabelIds: [to], removeLabelIds: [from] },
        });
    }

    async ensureFolders(folders: readonly string[]): Promise<void> {
        for (const folder of folders) await this.labelId(folder, true);
    }

    /**
     * The id Gmail knows a label by, listing once per session and creating on demand.
     *
     * `create` is false on the read path: a poll of an account where nobody has made the label yet
     * should read nothing, not conjure a label as a side effect of looking.
     */
    private async labelId(name: string, create: boolean): Promise<string | undefined> {
        if (!this.labelsListed) {
            const listed = await this.http.json<GmailLabelList>("/labels");
            for (const label of listed.labels ?? []) {
                if (label.id && label.name) this.labelIds.set(label.name, label.id);
            }
            this.labelsListed = true;
        }

        const known = this.labelIds.get(name);
        if (known !== undefined || !create) return known;

        // Gmail creates the `/`-nested hierarchy itself, so `assistants/failed` needs no separate
        // `assistants`. A failure here is deliberately not swallowed: unlike IMAP's CREATE, which
        // has no portable "already exists" code, this one is only ever reached for a label the list
        // above did not have — so it failing means something is actually wrong, and the ingest's
        // wholesale-failure path is the right place for it.
        const created = await this.http.json<GmailLabel>("/labels", {
            method: "POST",
            body: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
        });
        if (!created.id) throw new Error(`Gmail created the label "${name}" but returned no id`);
        log.info("created mail folder", { folder: name });
        this.labelIds.set(name, created.id);
        return created.id;
    }

    /**
     * Up to `max` message ids carrying `labelId`, following `nextPageToken` if it takes one.
     *
     * Gmail may answer with fewer results than asked for *and* a page token, so `maxResults` alone
     * does not bound the walk: `max` does, and it is the ingest's `MAIL_MAX_PER_POLL`.
     */
    private async listMessageIds(labelId: string, max: number): Promise<string[]> {
        const ids: string[] = [];
        let pageToken: string | undefined;

        while (ids.length < max) {
            const query = new URLSearchParams({
                labelIds: labelId,
                maxResults: String(max - ids.length),
            });
            if (pageToken) query.set("pageToken", pageToken);
            const page = await this.http.json<GmailMessageList>(`/messages?${query.toString()}`);
            for (const message of page.messages ?? []) {
                if (message.id) ids.push(message.id);
            }
            pageToken = page.nextPageToken;
            if (!pageToken || (page.messages ?? []).length === 0) break;
        }

        return ids.slice(0, max);
    }
}

/**
 * The `uid` a Gmail message is known by upstairs, and why it is not the Gmail id.
 *
 * `FetchedMessage.uid` is a `number` — it is an IMAP UID everywhere else in the Runtime — and a
 * Gmail message id is a 16-digit hex string, sixty-four bits, which no double holds exactly.
 * Widening the type would mean editing `email.ts`, `watcher/mail.ts` and every signature between
 * them for the benefit of one transport, so the id is carried whole in {@link MessageOrigin}
 * instead and the number is derived from it.
 *
 * The derivation is a truncated SHA-256, kept to 48 bits so it is a safe integer, and it is
 * *deterministic*: the same message computes the same uid on every poll, which is what idempotency
 * needs. It is used for two things and neither one is identity — logging, and the session's own map
 * back to the Gmail id for `move`.
 *
 * **The identity is `origin`, not this.** `parseMessage` synthesises `<uid.N.vV.folder@host>` for a
 * sender who omitted the `Message-ID`, and `V` here is the Gmail id itself (see
 * {@link originGeneration}) — globally unique and never reused by Google, so that ref cannot
 * collide even if two uids did.
 */
export function numericUid(gmailId: string): number {
    return parseInt(createHash("sha256").update(gmailId).digest("hex").slice(0, 12), 16);
}

/**
 * What goes in {@link MessageOrigin.uidValidity} — the Gmail message id.
 *
 * The field is named for IMAP's generation counter, and its *job* is to make a synthesised
 * `Message-ID` unique to one message for ever: over IMAP a UID means nothing without the generation
 * it was issued in, because recreating a label restarts the numbering. Gmail has no such counter and
 * needs none — its message ids are globally unique and never reused, across labels, across deletes
 * — so the honest value to record is the id itself. It makes the ref unconditionally unique rather
 * than unique-per-generation, which is strictly stronger than what IMAP can offer.
 *
 * `parseMessage` only ever compares refs, and `refToken` sanitises what it embeds, so a hex string
 * where a number once was is safe.
 */
export function originGeneration(gmailId: string): string {
    return gmailId;
}

/**
 * One header, normalised into the bare lowercase address the allowlist is checked against.
 *
 * The normalisation itself is `email.ts`'s exported {@link envelopeAddress} — the same function the
 * IMAP path uses on the IMAP envelope — because the ingest compares both transports' output against
 * one allowlist and a gate whose halves disagree about what an address *is* is not a gate. IMAP
 * hands over a structured envelope with the display name already split off; a Gmail header is the
 * raw `Anna Beispiel <a@b.de>`, so the angle brackets are stripped here first and the trimming and
 * lowercasing are left to the shared function.
 */
function headerAddress(headers: GmailHeader[] | undefined, name: string): string {
    const header = (headers ?? []).find((entry) => (entry.name ?? "").toLowerCase() === name.toLowerCase());
    const value = header?.value ?? "";
    const angled = /<([^>]*)>/.exec(value);
    return envelopeAddress({ from: [{ address: angled?.[1] ?? value }] });
}

/**
 * The HTTP half: one access token, refreshed when it expires and once more when the API disagrees.
 *
 * The refresh-token grant is the whole of the authentication. The access token it returns lives
 * about an hour, is held in memory only, and is never written to a log or an error message — the
 * refresh token even less so. The one-retry-after-reauth is the same shape `a12/client.ts` uses
 * against the ThingStore: whoever gets the 401 clears the token, because otherwise the next call
 * re-presents the credential the server has just refused.
 */
class GmailHttp {
    private readonly doFetch: typeof fetch;
    private token: { value: string; expiresAt: number } | undefined;

    constructor(private readonly options: GmailOptions) {
        this.doFetch = options.fetchImpl ?? fetch;
    }

    /** `users/<address>`, or `users/me` when nobody named one. */
    private get userPath(): string {
        const user = this.options.user.trim();
        return `${GMAIL_API}/users/${encodeURIComponent(user === "" ? "me" : user)}`;
    }

    /** One authorised call against the Gmail API, retried exactly once after a re-auth on 401. */
    async json<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
        const url = `${this.userPath}${path}`;

        let response = await this.send(url, init, await this.accessToken());
        if (response.status === 401) {
            log.debug("Gmail returned 401, refreshing the access token");
            this.token = undefined;
            response = await this.send(url, init, await this.accessToken());
        }
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new Error(`Gmail ${init.method ?? "GET"} ${path} failed: HTTP ${response.status} ${text.slice(0, 300)}`);
        }
        return (await response.json()) as T;
    }

    private async send(url: string, init: { method?: string; body?: unknown }, token: string): Promise<Response> {
        return this.doFetch(url, {
            method: init.method ?? "GET",
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${token}`,
                ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        });
    }

    /** The cached access token, minted from the refresh token when it is missing or nearly stale. */
    private async accessToken(): Promise<string> {
        const cached = this.token;
        if (cached && Date.now() < cached.expiresAt - TOKEN_SKEW_MS) return cached.value;

        const response = await this.doFetch(TOKEN_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Accept: "application/json",
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            body: new URLSearchParams({
                client_id: this.options.clientId,
                client_secret: this.options.clientSecret,
                refresh_token: this.options.refreshToken,
                grant_type: "refresh_token",
            }),
        });
        if (!response.ok) {
            // Google's body on a refused grant is `{"error":"invalid_grant"}` and carries no
            // secret, but it is still not worth quoting at length in a household's log.
            const text = await response.text().catch(() => "");
            throw new Error(`Gmail refused the refresh token: HTTP ${response.status} ${text.slice(0, 200)}`);
        }
        const payload = (await response.json()) as { access_token?: string; expires_in?: number };
        if (!payload.access_token) {
            throw new Error("Gmail accepted the refresh token but returned no access_token");
        }
        this.token = {
            value: payload.access_token,
            expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
        };
        log.debug("obtained a Gmail access token", { expiresIn: payload.expires_in ?? 3600 });
        return this.token.value;
    }
}

// The subset of Gmail's resources this file reads. Everything else they return is ignored.

interface GmailLabel {
    id?: string;
    name?: string;
}

interface GmailLabelList {
    labels?: GmailLabel[];
}

interface GmailMessageList {
    messages?: Array<{ id?: string }>;
    nextPageToken?: string;
}

interface GmailHeader {
    name?: string;
    value?: string;
}

interface GmailMessage {
    id?: string;
    /** Gmail's estimate of the RFC822 size, in bytes. */
    sizeEstimate?: number;
    /** Epoch milliseconds, as a string. */
    internalDate?: string;
    /** Present only for `format=raw`, and base64url rather than base64. */
    raw?: string;
    payload?: { headers?: GmailHeader[] };
}
