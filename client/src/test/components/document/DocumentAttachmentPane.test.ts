import { describe, expect, it } from "vitest";

import { canPreview } from "../../../components/document/AttachmentPreview";
import { previewPropsFrom } from "../../../components/document/DocumentAttachmentPane";

describe("canPreview", () => {
    it("is true only for the registered renderers", () => {
        expect(canPreview("application/pdf")).toBe(true);
        expect(canPreview("text/plain")).toBe(true);
        expect(canPreview("application/pdf; charset=binary")).toBe(true);
        expect(canPreview("image/png")).toBe(false);
        expect(canPreview("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(false);
    });
});

const PDF = {
    attachment_id: "att-1",
    mime_type: "application/pdf",
    original_filename: "invoice.pdf"
};

function documentWith(attachment: object[], extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { Document: { Title: "Fwd: invoice", Attachment: attachment, ...extra } };
}

describe("previewPropsFrom", () => {
    it("builds preview props from the first stored attachment on a Document", () => {
        const props = previewPropsFrom("Document_DM", "Document_DM/one", documentWith([PDF]));
        expect(props).toEqual({
            docRef: "Document_DM/one",
            documentModelName: "Document_DM",
            attachmentId: "att-1",
            mimeType: "application/pdf",
            filename: "invoice.pdf"
        });
    });

    it("previews nothing for a form whose model is not the Document", () => {
        expect(previewPropsFrom("Party_DM", "Party_DM/one", documentWith([PDF]))).toBeUndefined();
    });

    it("reads a single-object Attachment group — the shape a repeatability-1 form delivers", () => {
        // The plain activity document (production path) delivers the group as a bare object, not an array.
        const props = previewPropsFrom("Document_DM", "Document_DM/one", { Document: { Title: "x", Attachment: PDF } });
        expect(props?.attachmentId).toBe("att-1");
        expect(props?.mimeType).toBe("application/pdf");
    });

    it("previews nothing when the Document has no attachment", () => {
        expect(previewPropsFrom("Document_DM", "Document_DM/one", documentWith([]))).toBeUndefined();
        expect(previewPropsFrom("Document_DM", "Document_DM/one", { Document: {} })).toBeUndefined();
    });

    it("skips attachment entries that carry no stored bytes yet", () => {
        const pending = { original_filename: "draft.pdf", mime_type: "application/pdf" }; // no attachment_id
        expect(previewPropsFrom("Document_DM", "Document_DM/one", documentWith([pending, PDF]))?.attachmentId).toBe(
            "att-1"
        );
    });

    it("falls back to the CDD's t_docRef when no instance docRef is given", () => {
        const props = previewPropsFrom("Document_DM", undefined, documentWith([PDF], { t_docRef: "Document_DM/two" }));
        expect(props?.docRef).toBe("Document_DM/two");
    });

    it("falls back to t_docRef when the instance docRef is the empty string, not just undefined", () => {
        // A form reached without a docRef delivers instance as "", which must not shadow t_docRef; a
        // blank docRef would mint a ticket that is refused and show the download fallback instead.
        const props = previewPropsFrom("Document_DM", "", documentWith([PDF], { t_docRef: "Document_DM/two" }));
        expect(props?.docRef).toBe("Document_DM/two");
    });

    it("previews nothing when neither an instance docRef nor a t_docRef resolves", () => {
        expect(previewPropsFrom("Document_DM", "", documentWith([PDF]))).toBeUndefined();
        expect(previewPropsFrom("Document_DM", "", documentWith([PDF], { t_docRef: "" }))).toBeUndefined();
    });

    it("falls back to the internal filename, then a constant, when no original filename is present", () => {
        const noName = { attachment_id: "att-9", mime_type: "text/plain", internal_filename: "blob.bin" };
        expect(previewPropsFrom("Document_DM", "Document_DM/one", documentWith([noName]))?.filename).toBe("blob.bin");
    });
});
