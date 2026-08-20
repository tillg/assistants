import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AttachmentPreview, type AttachmentPreviewProps } from "../../../components/document/AttachmentPreview";

import { Frame } from "../conversation/harness";

// The preview mints its download ticket through the platform loader; the whole feature turns on that
// one call, so it is the seam every test drives. `vi.mock` is hoisted above these imports by vitest.
const retrieveDownloadLink = vi.hoisted(() => vi.fn());
vi.mock("@com.mgmtp.a12.formengine/formengine-core", () => ({
    platformAttachmentLoader: { retrieveDownloadLink }
}));

const createObjectURL = vi.fn<(blob: Blob) => string>(() => "blob:mock-url");
const revokeObjectURL = vi.fn();
const fetchMock = vi.fn();
const openMock = vi.fn();

const PDF: AttachmentPreviewProps = {
    docRef: "Document_DM/one",
    documentModelName: "Document_DM",
    attachmentId: "att-1",
    filename: "invoice.pdf",
    mimeType: "application/pdf"
};

function fetchResolves(blob: Blob, ok = true): void {
    fetchMock.mockResolvedValue({ ok, status: ok ? 200 : 404, blob: () => Promise.resolve(blob) });
}

beforeEach(() => {
    retrieveDownloadLink.mockReset().mockResolvedValue("http://localhost:8082/cs/download/tkt?filename=invoice.pdf");
    createObjectURL.mockReset().mockReturnValue("blob:mock-url");
    revokeObjectURL.mockReset();
    fetchMock.mockReset();
    openMock.mockReset();
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true, writable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true, writable: true });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("open", openMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("AttachmentPreview", () => {
    it("renders a PDF in a frame pointed at an object URL, fetched same-origin", async () => {
        fetchResolves(new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" }));

        render(
            <Frame>
                <AttachmentPreview {...PDF} />
            </Frame>
        );

        const frame = await screen.findByTestId("attachment-preview-pdf");
        expect(frame).toHaveAttribute("src", "blob:mock-url");
        // No `sandbox`: Chrome will not run its PDF viewer inside a sandboxed frame (measured). Isolation
        // is the browser's PDF viewer plus the pinned blob type below.
        expect(frame).not.toHaveAttribute("sandbox");
        // The cross-origin ticket URL is reduced to its path, so the request is same-origin.
        expect(fetchMock).toHaveBeenCalledWith("/cs/download/tkt?filename=invoice.pdf");
        // The blob handed to the frame is pinned to the declared type, not the response's — a store that
        // served `text/html` cannot smuggle markup into the un-sandboxed frame.
        const blobArg = createObjectURL.mock.calls[0]?.[0];
        expect(blobArg?.type).toBe("application/pdf");
    });

    it("pins the blob to the declared type even when the store mislabels the bytes", async () => {
        // Hostile: a Document that claims application/pdf whose bytes the store serves as text/html.
        fetchResolves(new Blob(["<script>alert(1)</script>"], { type: "text/html" }));

        render(
            <Frame>
                <AttachmentPreview {...PDF} />
            </Frame>
        );

        await screen.findByTestId("attachment-preview-pdf");
        const blobArg = createObjectURL.mock.calls[0]?.[0];
        expect(blobArg?.type).toBe("application/pdf");
    });

    it("shows a text/plain attachment as text, never as markup", async () => {
        const hostile = "<script>window.__pwned = true</script>hello";
        fetchResolves(new Blob([hostile], { type: "text/plain" }));

        render(
            <Frame>
                <AttachmentPreview {...PDF} mimeType="text/plain" filename="note.txt" />
            </Frame>
        );

        const pane = await screen.findByTestId("attachment-preview-text");
        expect(pane).toHaveTextContent("<script>window.__pwned = true</script>hello");
        expect(pane.querySelector("script")).toBeNull();
        expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
    });

    it("previews nothing for a type with no renderer, and mints no ticket", () => {
        const { container } = render(
            <Frame>
                <AttachmentPreview {...PDF} mimeType="image/png" filename="logo.png" />
            </Frame>
        );

        expect(container.querySelector("[data-role^='attachment-preview']")).toBeNull();
        expect(retrieveDownloadLink).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("degrades to the filename and a download link when the fetch fails", async () => {
        fetchResolves(new Blob(["x"]), false);

        render(
            <Frame>
                <AttachmentPreview {...PDF} />
            </Frame>
        );

        const refused = await screen.findByTestId("attachment-preview-refused");
        expect(refused).toHaveTextContent("invoice.pdf");

        // The download re-mints a fresh ticket — the one behind the preview is spent.
        retrieveDownloadLink.mockClear();
        fireEvent.click(screen.getByRole("button", { name: /download/i }));
        await waitFor(() => expect(retrieveDownloadLink).toHaveBeenCalledTimes(1));
    });

    it("revokes the object URL on unmount", async () => {
        fetchResolves(new Blob([new Uint8Array([1])], { type: "application/pdf" }));

        const { unmount } = render(
            <Frame>
                <AttachmentPreview {...PDF} />
            </Frame>
        );
        await screen.findByTestId("attachment-preview-pdf");

        unmount();
        expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
    });

    it("revokes the previous object URL when the attachment changes", async () => {
        fetchResolves(new Blob([new Uint8Array([1])], { type: "application/pdf" }));

        const { rerender } = render(
            <Frame>
                <AttachmentPreview {...PDF} />
            </Frame>
        );
        await screen.findByTestId("attachment-preview-pdf");

        createObjectURL.mockReturnValue("blob:mock-url-2");
        rerender(
            <Frame>
                <AttachmentPreview {...PDF} attachmentId="att-2" />
            </Frame>
        );

        await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url"));
    });
});
