/**
 * What the Content Store upload puts on the wire.
 *
 * Every assertion here is checked against the web application's own uploader —
 * `AttachmentUploadV2.Request.build` in `@com.mgmtp.a12.dataservices/dataservices-access` and
 * `platformAttachmentLoader` in `@com.mgmtp.a12.formengine/formengine-core` — because that request
 * is the only proof we have of what the server accepts. Nothing in TypeScript can catch a wrong
 * query-parameter name or a doubly-encoded filename; the symptom is a 400 from a live server, so
 * the shape is pinned here instead.
 */

import { describe, expect, it, vi } from "vitest";
import {
    ContentStoreClient,
    ContentStoreDownloadError,
    ContentStoreUploadError,
    type TokenSource,
} from "../../src/a12/content.js";

/** A token source that counts, so the 401 retry can be observed rather than inferred. */
function tokenSource(tokens: string[] = ["token-1", "token-2"]): TokenSource & {
    invalidated: number;
    handed: string[];
} {
    const handed: string[] = [];
    let index = 0;
    return {
        invalidated: 0,
        handed,
        async getToken(): Promise<string> {
            const token = tokens[Math.min(index, tokens.length - 1)]!;
            handed.push(token);
            return token;
        },
        invalidate(): void {
            this.invalidated += 1;
            index += 1;
        },
    };
}

const HEADER = {
    attachmentId: "c5a1e746-d799-40b1-bcdc-92de6c93f1a1",
    filename: "c5a1e746-d799-40b1-bcdc-92de6c93f1a1.pdf",
    mimeType: "application/pdf",
    size: 1234,
    bigThumbnailUrl: "ignored",
};

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

function clientWith(
    fetchImpl: typeof fetch,
    source: TokenSource = tokenSource(),
): ContentStoreClient {
    return new ContentStoreClient({
        baseUrl: "http://server:8080",
        tokenSource: source,
        fetchImpl,
    });
}

describe("the upload URL", () => {
    it("is /api/v2/attachment with the three query parameters the platform sends", () => {
        const client = clientWith(vi.fn());
        expect(client.url("invoice.pdf")).toBe(
            "http://server:8080/api/v2/attachment" +
                "?filename=invoice.pdf" +
                "&documentModelName=Document_DM" +
                "&pathToField=%2FDocument%2FAttachment",
        );
    });

    it("encodes each parameter exactly once, so a filename may contain & # and spaces", () => {
        // The reference builder encodes per parameter and then tells the connector *not* to encode
        // the URL again. A filename like this is precisely what a doubly-encoded URL mangles.
        const client = clientWith(vi.fn());
        const url = client.url("R&D report #7.pdf");
        expect(url).toContain("filename=R%26D%20report%20%237.pdf");
        // Encoded once, not twice: no stray %25 (an encoded '%') anywhere.
        expect(url).not.toContain("%25");
    });

    it("takes a different Model and attachment path when one is configured", () => {
        const client = new ContentStoreClient({
            baseUrl: "http://server:8080",
            tokenSource: tokenSource(),
            documentModelName: "Other_DM",
            pathToField: "/Other/Scan",
        });
        expect(client.url("a.png")).toContain("documentModelName=Other_DM");
        expect(client.url("a.png")).toContain("pathToField=%2FOther%2FScan");
    });

    it("does not double the slash when the base URL has a trailing one", () => {
        const client = new ContentStoreClient({
            baseUrl: "http://server:8080/",
            tokenSource: tokenSource(),
        });
        expect(client.url("a.png")).toContain("http://server:8080/api/v2/attachment");
        expect(client.url("a.png")).not.toContain("8080//api");
    });
});

describe("the request", () => {
    it("POSTs the raw bytes with the browser's headers and a Bearer token", async () => {
        const doFetch = vi.fn().mockResolvedValue(jsonResponse(HEADER));
        const bytes = Buffer.from("%PDF-1.4 not really a pdf");
        await clientWith(doFetch as unknown as typeof fetch).upload(
            "invoice.pdf",
            "application/pdf",
            bytes,
        );

        expect(doFetch).toHaveBeenCalledTimes(1);
        const [url, init] = doFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toContain("/api/v2/attachment?filename=invoice.pdf");
        expect(init.method).toBe("POST");
        // The body is the file itself — no multipart envelope, no FormData, no field name.
        expect(init.body).toBe(bytes);

        const headers = init.headers as Record<string, string>;
        expect(headers["Authorization"]).toBe("Bearer token-1");
        expect(headers["Accept"]).toBe("application/json");
        // Binary body, JSON label. This is what the web application sends; see content.ts.
        expect(headers["Content-Type"]).toBe("application/json;charset=utf8");
    });
});

describe("the returned attachment group", () => {
    it("carries attachment_id and deliberately leaves content unset", async () => {
        const doFetch = vi.fn().mockResolvedValue(jsonResponse(HEADER));
        const result = await clientWith(doFetch as unknown as typeof fetch).upload(
            "invoice.pdf",
            "application/pdf",
            Buffer.alloc(10),
        );

        expect(result).toEqual({
            original_filename: "invoice.pdf",
            internal_filename: "c5a1e746-d799-40b1-bcdc-92de6c93f1a1.pdf",
            attachment_id: "c5a1e746-d799-40b1-bcdc-92de6c93f1a1",
            size: 1234,
            mime_type: "application/pdf",
        });
        // Document_DM's AttachmentIdOrContentFilled rule is NotExactlyOneFieldFilled(attachment_id,
        // content). Setting both is a validation error, not belt and braces.
        expect(result.content).toBeUndefined();
        expect("content" in result).toBe(false);
    });

    it("keeps the original filename even though the server renames the stored file", async () => {
        const doFetch = vi.fn().mockResolvedValue(jsonResponse(HEADER));
        const result = await clientWith(doFetch as unknown as typeof fetch).upload(
            "Rechnung Mai.pdf",
            "application/pdf",
            Buffer.alloc(1),
        );
        expect(result.original_filename).toBe("Rechnung Mai.pdf");
        expect(result.internal_filename).not.toBe("Rechnung Mai.pdf");
    });

    it("falls back to what we know when the response omits the optional fields", async () => {
        // Only attachmentId is required by the platform's own type guard, so every other field has
        // to have an answer. internal_filename in particular is required by the Model's rule, and
        // an absent one would fail ADD_DOCUMENT rather than this call.
        const doFetch = vi.fn().mockResolvedValue(jsonResponse({ attachmentId: "abc" }));
        const result = await clientWith(doFetch as unknown as typeof fetch).upload(
            "note.txt",
            "text/plain",
            Buffer.alloc(42),
        );
        expect(result).toEqual({
            original_filename: "note.txt",
            internal_filename: "note.txt",
            attachment_id: "abc",
            size: 42,
            mime_type: "text/plain",
        });
    });
});

describe("failure", () => {
    it("re-authenticates once and retries after a 401", async () => {
        const source = tokenSource(["stale", "fresh"]);
        const doFetch = vi
            .fn()
            .mockResolvedValueOnce(new Response("", { status: 401 }))
            .mockResolvedValueOnce(jsonResponse(HEADER));

        const result = await clientWith(doFetch as unknown as typeof fetch, source).upload(
            "invoice.pdf",
            "application/pdf",
            Buffer.alloc(1),
        );

        expect(doFetch).toHaveBeenCalledTimes(2);
        expect(source.invalidated).toBe(1);
        expect(source.handed).toEqual(["stale", "fresh"]);
        const second = doFetch.mock.calls[1] as [string, RequestInit];
        expect((second[1].headers as Record<string, string>)["Authorization"]).toBe("Bearer fresh");
        expect(result.attachment_id).toBe(HEADER.attachmentId);
    });

    it("gives up after a second 401 rather than looping", async () => {
        const doFetch = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
        await expect(
            clientWith(doFetch as unknown as typeof fetch).upload("a.pdf", "application/pdf", Buffer.alloc(1)),
        ).rejects.toBeInstanceOf(ContentStoreUploadError);
        expect(doFetch).toHaveBeenCalledTimes(2);
    });

    it("names the status and the server's own words, which is where the reason lives", async () => {
        // The realistic 400 here is the MIME allowlist: the server sniffs the real type from the
        // bytes and refuses anything outside grtnr.assistants.server.attachment.allowedMimeTypes.
        const doFetch = vi.fn().mockResolvedValue(
            new Response('{"longMessage":{"key":"content-store.invalid.type"}}', { status: 400 }),
        );
        const error = await clientWith(doFetch as unknown as typeof fetch)
            .upload("invoice.pdf", "application/pdf", Buffer.alloc(1))
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(ContentStoreUploadError);
        const upload = error as ContentStoreUploadError;
        expect(upload.status).toBe(400);
        expect(upload.filename).toBe("invoice.pdf");
        expect(upload.message).toContain("400");
        expect(upload.message).toContain("invoice.pdf");
        expect(upload.message).toContain("content-store.invalid.type");
    });

    it("reports a 403, which is what the runtime role gets without ATTACHMENT_UPLOAD", async () => {
        const doFetch = vi.fn().mockResolvedValue(new Response("Forbidden", { status: 403 }));
        const error = await clientWith(doFetch as unknown as typeof fetch)
            .upload("a.pdf", "application/pdf", Buffer.alloc(1))
            .catch((caught: unknown) => caught);
        expect((error as ContentStoreUploadError).status).toBe(403);
        // Not retried: a 403 is a missing access right, and asking for the token again cannot fix it.
        expect(doFetch).toHaveBeenCalledTimes(1);
    });

    it("refuses a 200 that is not JSON", async () => {
        const doFetch = vi.fn().mockResolvedValue(new Response("<html>proxied away</html>", { status: 200 }));
        await expect(
            clientWith(doFetch as unknown as typeof fetch).upload("a.pdf", "application/pdf", Buffer.alloc(1)),
        ).rejects.toThrow(/not JSON/);
    });

    it("refuses a 200 that carries no attachmentId, rather than storing a dangling reference", async () => {
        const doFetch = vi.fn().mockResolvedValue(jsonResponse({ filename: "a.pdf", size: 1 }));
        await expect(
            clientWith(doFetch as unknown as typeof fetch).upload("a.pdf", "application/pdf", Buffer.alloc(1)),
        ).rejects.toThrow(/no attachmentId/);
    });
});

/**
 * Reading the bytes back, which is a different route from writing them: `/cs` is download-only, and
 * the id is the whole request. The readers hand what comes back straight to `pdfjs` or to a vision
 * model, so anything this returns other than the exact bytes is a document read wrong.
 */
describe("the download", () => {
    it("GETs /cs/download/<attachmentId> with a Bearer token and nothing else", async () => {
        const pdf = Buffer.from("%PDF-1.4 pretend");
        const doFetch = vi.fn().mockResolvedValue(new Response(pdf, { status: 200 }));

        const bytes = await clientWith(doFetch as unknown as typeof fetch).download("att-42");

        expect(bytes.equals(pdf)).toBe(true);
        const [url, init] = doFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("http://server:8080/cs/download/att-42");
        expect(init.method).toBe("GET");
        // No metadata rides along: the store already knows what it stored.
        expect(init.body).toBeUndefined();
        expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer token-1");
    });

    it("encodes the id, so a store that ever hands out an awkward one still resolves", async () => {
        const doFetch = vi.fn().mockResolvedValue(new Response(Buffer.alloc(1), { status: 200 }));
        await clientWith(doFetch as unknown as typeof fetch).download("a/b c");
        expect((doFetch.mock.calls[0] as [string])[0]).toBe("http://server:8080/cs/download/a%2Fb%20c");
    });

    it("re-authenticates once after a 401, exactly as the upload does", async () => {
        const source = tokenSource(["stale", "fresh"]);
        const doFetch = vi
            .fn()
            .mockResolvedValueOnce(new Response("", { status: 401 }))
            .mockResolvedValueOnce(new Response(Buffer.from("%PDF"), { status: 200 }));

        const bytes = await clientWith(doFetch as unknown as typeof fetch, source).download("att-1");

        expect(doFetch).toHaveBeenCalledTimes(2);
        expect(source.invalidated).toBe(1);
        expect(bytes.toString()).toBe("%PDF");
    });

    it("names the status and the attachment when the store refuses", async () => {
        // A 404 is the realistic one: an attachment id on a Document whose bytes are gone.
        const doFetch = vi.fn().mockResolvedValue(new Response("no such attachment", { status: 404 }));
        const error = await clientWith(doFetch as unknown as typeof fetch)
            .download("att-gone")
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(ContentStoreDownloadError);
        const download = error as ContentStoreDownloadError;
        expect(download.status).toBe(404);
        expect(download.attachmentId).toBe("att-gone");
        expect(download.message).toContain("404");
        expect(download.message).toContain("no such attachment");
    });

    it("returns the bytes untouched, so a PDF is still a PDF", async () => {
        // A response read as text and re-encoded would corrupt every binary that is not valid UTF-8,
        // and the symptom would be pdfjs reporting a corrupt file rather than an obvious failure.
        const binary = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0x80, 0x0a]);
        const doFetch = vi.fn().mockResolvedValue(new Response(binary, { status: 200 }));

        const bytes = await clientWith(doFetch as unknown as typeof fetch).download("att-1");

        expect([...bytes]).toEqual([...binary]);
    });
});

/**
 * Needs the full stack up (`just dev`): a running server on :8082, Keycloak, and the `runtime`
 * identity holding the `ATTACHMENT_UPLOAD` access right — which `import/auth/roles.yaml` does not
 * grant it today. It also needs the uploaded type to be inside
 * `grtnr.assistants.server.attachment.allowedMimeTypes`, currently `image/png,image/jpeg`.
 *
 * Until both are true this cannot pass, and neither file is this change's to edit.
 */
describe.skip("against a live stack", () => {
    it("uploads a PNG and the returned attachment_id downloads the same bytes", () => {
        // POST /api/v2/attachment, then GET /api/attachment/download/{attachmentId}?docRef={docRef}
        // once a Document referencing it exists.
    });
});
