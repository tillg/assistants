/**
 * Uploading a binary to the A12 Content Store.
 *
 * This is the first code in this repository to write bytes rather than JSON to A12, so the whole
 * of what was discovered is written down here rather than left to be rediscovered.
 *
 * **The route is a plain REST POST and it is reachable from a non-browser client.** The web
 * application's own uploader — `platformAttachmentLoader` in
 * `@com.mgmtp.a12.formengine/formengine-core`, which builds its request with
 * `AttachmentUploadV2.Request.build` in `@com.mgmtp.a12.dataservices/dataservices-access` — issues
 * exactly one request per file:
 *
 *     POST {baseUrl}/api/v2/attachment
 *          ?filename=<name>&documentModelName=<model>&pathToField=<path to the attachment group>
 *
 * with the **raw bytes as the body**. There is no multipart envelope, no `FormData` and no browser
 * session: every parameter travels in the query string and the payload is the file itself. (An
 * older `POST /api/attachment/upload` *does* use `FormData`; it is the v1 route and is not what the
 * form engine calls. Do not follow it.)
 *
 * Three details are load-bearing and none of them is guessable:
 *
 *   1. **`Content-Type` is `application/json;charset=utf8`, on a request whose body is binary.**
 *      That is not a mistake here — it is what the browser sends. A12's `HeadersFilter` replaces
 *      the header set wholesale for every REST request it makes, so the raw `ArrayBuffer` goes out
 *      labelled as JSON and the server reads the body stream regardless of the label. We mirror it
 *      because the browser's request is the one demonstrably accepted; sending the honest
 *      `application/octet-stream` is an untested deviation on the one call we cannot easily retry.
 *   2. **The query string is pre-encoded and must not be encoded again.** The reference builder
 *      applies `encodeURIComponent` per parameter and then sets `needUrlEncoded: false` so the
 *      connector skips its usual `encodeURI` pass. A filename containing `&` or `#` is the case
 *      that breaks if this is got wrong.
 *   3. **`Bearer`, not `UAABearer`** — the same Keycloak token the JSON-RPC client already carries,
 *      for the same reason (see `client.ts`). This is why the constructor takes a token source
 *      instead of credentials: there must be exactly one place that talks to Keycloak.
 *
 * The response is an A12 `AttachmentHeader`, and what we return is the attachment group of
 * `Document_DM` ready to be handed to `ADD_DOCUMENT` — nothing else has to be derived by the
 * caller.
 *
 * **`attachment_id` and `content` are mutually exclusive.** `Document_DM`'s
 * `AttachmentIdOrContentFilled` rule is `NotExactlyOneFieldFilled(attachment_id, content)`: an
 * attachment is *either* a Content Store reference *or* inline base64, never both and never
 * neither. Since we upload, we set `attachment_id` and must leave `content` unset — populating both
 * "to be safe" is a validation error, not belt and braces.
 *
 * **Reading the bytes back is a different route.** `/cs` is download-only — `GET
 * /cs/download/<attachmentId>` — which is the one the two document readers use to get an attachment
 * in front of `pdfjs` or a vision model. See {@link ContentStoreClient.download}.
 */

import { describeError, log } from "../log.js";

/** No outbound call may hang the scan loop. Generous, because this one carries a file. */
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Where the Runtime's Keycloak token comes from.
 *
 * Deliberately an interface rather than credentials: authenticating is `A12Client`'s job and
 * duplicating the password grant here would give the Runtime two things that can hold a stale
 * token and disagree about it. `invalidate()` exists so a 401 can be retried the same way the
 * JSON-RPC client retries one — drop the token, ask again, send again, once.
 */
export interface TokenSource {
    getToken(): Promise<string>;
    invalidate(): void;
}

/** Exactly what a `Document_DM` `Attachment` group needs to be openable in the web application. */
export interface UploadedAttachment {
    original_filename: string;
    internal_filename?: string;
    attachment_id?: string;
    content?: string;
    size: number;
    mime_type: string;
}

export interface ContentStoreOptions {
    /** The same base URL the JSON-RPC client uses, e.g. `http://thingstore:8082`. */
    baseUrl: string;
    tokenSource: TokenSource;
    /**
     * The Model the attachment will hang off, and the path to its attachment group. The server
     * uses both to find the group in the Model and apply its configured MIME-type restriction, so
     * they must match the Model on disk or the upload is refused.
     */
    documentModelName?: string;
    pathToField?: string;
    fetchImpl?: typeof fetch;
}

/**
 * The A12 `AttachmentHeader` the upload answers with. Every field but `attachmentId` is optional in
 * the platform's own type guard, which is why each one below has a fallback.
 */
interface AttachmentHeader {
    attachmentId: string;
    filename?: string;
    mimeType?: string;
    size?: number;
}

export class ContentStoreDownloadError extends Error {
    constructor(
        readonly status: number,
        readonly attachmentId: string,
        detail: string,
    ) {
        super(
            `Downloading attachment '${attachmentId}' from the Content Store failed: HTTP ${status}` +
                (detail ? ` — ${detail}` : ""),
        );
        this.name = "ContentStoreDownloadError";
    }
}

export class ContentStoreUploadError extends Error {
    constructor(
        readonly status: number,
        readonly filename: string,
        detail: string,
    ) {
        super(
            `Uploading '${filename}' to the Content Store failed: HTTP ${status}` +
                (detail ? ` — ${detail}` : ""),
        );
        this.name = "ContentStoreUploadError";
    }
}

export class ContentStoreClient {
    private readonly baseUrl: string;
    private readonly documentModelName: string;
    private readonly pathToField: string;
    private readonly doFetch: typeof fetch;

    constructor(private readonly options: ContentStoreOptions) {
        this.baseUrl = options.baseUrl.replace(/\/+$/, "");
        this.documentModelName = options.documentModelName ?? "Document_DM";
        this.pathToField = options.pathToField ?? "/Document/Attachment";
        this.doFetch = options.fetchImpl ?? fetch;
    }

    /**
     * The upload URL, built the way the reference implementation builds it: each parameter encoded
     * once, and the result never encoded again.
     */
    url(filename: string): string {
        const query =
            `filename=${encodeURIComponent(filename)}` +
            `&documentModelName=${encodeURIComponent(this.documentModelName)}` +
            `&pathToField=${encodeURIComponent(this.pathToField)}`;
        return `${this.baseUrl}/api/v2/attachment?${query}`;
    }

    /** Store the bytes, and return the attachment group that references them. */
    async upload(filename: string, mimeType: string, bytes: Buffer): Promise<UploadedAttachment> {
        const url = this.url(filename);

        const send = async (token: string): Promise<Response> =>
            this.doFetch(url, {
                method: "POST",
                headers: {
                    Accept: "application/json",
                    // Binary body, JSON label. See the note at the top of this file — this is what
                    // the web application sends, and it is deliberate.
                    "Content-Type": "application/json;charset=utf8",
                    Authorization: `Bearer ${token}`,
                },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                body: bytes,
            });

        let response = await send(await this.options.tokenSource.getToken());
        if (response.status === 401) {
            log.debug("Content Store returned 401, re-authenticating");
            this.options.tokenSource.invalidate();
            response = await send(await this.options.tokenSource.getToken());
        }
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new ContentStoreUploadError(response.status, filename, text.slice(0, 500));
        }

        const header = await this.readHeader(response, filename);

        log.debug("stored an attachment in the Content Store", {
            filename,
            attachmentId: header.attachmentId,
            bytes: bytes.length,
        });

        return {
            original_filename: filename,
            // Required by the Model's `AttachmentInternalFilenameRequired` rule. The server names
            // the stored file and normally echoes it back; falling back to the original keeps the
            // group valid rather than letting ADD_DOCUMENT fail on a missing field.
            internal_filename: header.filename ?? filename,
            attachment_id: header.attachmentId,
            // `content` is left unset on purpose — see the mutual-exclusion note above.
            size: header.size ?? bytes.length,
            mime_type: header.mimeType ?? mimeType,
        };
    }

    /**
     * The bytes behind an attachment id.
     *
     * **A different route from the upload, and not its mirror image.** `/cs` is *download*-only —
     * `GET /cs/download/<attachmentId>` — which is why the upload goes to `/api/v2/attachment` and
     * this does not. Nothing rides in the query string here: the id is the whole request, because
     * the Content Store already knows the filename, the MIME type and the size it stored.
     *
     * The same `Bearer` token as everywhere else, for the same reason. The server lists this path
     * among its introspection whitelist, so an anonymous GET may well be accepted too — that is the
     * server's business and not a licence for the Runtime to stop identifying itself.
     */
    async download(attachmentId: string): Promise<Buffer> {
        const url = `${this.baseUrl}/cs/download/${encodeURIComponent(attachmentId)}`;

        const send = async (token: string): Promise<Response> =>
            this.doFetch(url, {
                method: "GET",
                headers: {
                    // Whatever the store holds. It is a PDF today and it is not this client's place
                    // to insist on one.
                    Accept: "*/*",
                    Authorization: `Bearer ${token}`,
                },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });

        let response = await send(await this.options.tokenSource.getToken());
        if (response.status === 401) {
            log.debug("Content Store returned 401 on a download, re-authenticating");
            this.options.tokenSource.invalidate();
            response = await send(await this.options.tokenSource.getToken());
        }
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new ContentStoreDownloadError(response.status, attachmentId, text.slice(0, 500));
        }

        const bytes = Buffer.from(await response.arrayBuffer());
        log.debug("read an attachment from the Content Store", { attachmentId, bytes: bytes.length });
        return bytes;
    }

    private async readHeader(response: Response, filename: string): Promise<AttachmentHeader> {
        let payload: unknown;
        try {
            payload = await response.json();
        } catch (error) {
            throw new ContentStoreUploadError(
                response.status,
                filename,
                `the response was not JSON (${describeError(error)})`,
            );
        }
        if (!isAttachmentHeader(payload)) {
            throw new ContentStoreUploadError(
                response.status,
                filename,
                `the response carried no attachmentId: ${JSON.stringify(payload).slice(0, 200)}`,
            );
        }
        return payload;
    }
}

/**
 * `attachmentId` is the only field the platform's own guard insists on, so it is the only one
 * insisted on here. A response without it is not an attachment we can reference, and accepting it
 * would produce a Document whose attachment silently points at nothing.
 */
function isAttachmentHeader(value: unknown): value is AttachmentHeader {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as Record<string, unknown>;
    return typeof candidate["attachmentId"] === "string" && candidate["attachmentId"] !== "";
}
