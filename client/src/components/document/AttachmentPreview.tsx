/*
 * SPDX-License-Identifier: EUPL-1.2
 *
 * Copyright (c) 2026 Till Gartner
 *
 * Part of Assistants.
 *
 * Licensed under the European Union Public Licence, version 1.2 - see
 * https://eupl.eu/ and the LICENSE file at the root of this repository.
 * Distributed on an "AS IS" basis, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.
 */

/**
 * Read the attachment without leaving the Document — a reading affordance and nothing else.
 *
 * A **dispatcher on `mimeType`** over a small registry of renderers. Byte delivery is
 * {@link useAttachmentSource}'s job and is mime-agnostic; this file only decides how the bytes are
 * drawn. `application/pdf` goes to the browser's own PDF viewer in an iframe (deliberately *not*
 * sandboxed — see `PdfFrame`); `text/plain` is escaped into a `<pre>`; a type with **no registered
 * renderer** previews nothing at all — today's
 * icon-and-download stands, and no ticket is even minted for it. Images are deliberately absent: A12's
 * File Picker already previews them. Registering a renderer here is how a later change adds a format.
 */

import { useEffect, useState, type ReactElement } from "react";
import styled from "styled-components";

import { Typography } from "@com.mgmtp.a12.widgets/widgets-core";

import { previewStrings } from "./localize";
import { downloadAttachment, useAttachmentSource, type AttachmentRef, type PreviewSource } from "./useAttachmentSource";

export interface AttachmentPreviewProps extends AttachmentRef {
    readonly mimeType: string;
}

type AttachmentRenderer = (source: PreviewSource) => ReactElement;

/**
 * The PDF renders in a **centered A4-shaped frame** sized by height, not width: a full-width A4 frame
 * on a wide form would be `width × 1.414` tall, well past the viewport for a single page. `210 / 297`
 * is A4 portrait (210×297 mm); `80vh` fits one page without scrolling the outer page; the width falls
 * out of the ratio and `margin-inline: auto` centres it. Multi-page PDFs scroll inside the viewer.
 */
const PdfFrameElement = styled.iframe`
    display: block;
    margin-inline: auto;
    height: 80vh;
    aspect-ratio: 210 / 297;
    max-width: 100%;
    border: 1px solid ${({ theme }) => theme.colors.divider.colorSubtle};
    background: ${({ theme }) => theme.colors.background.nonInteractiveBackground};
`;

function PdfFrame({ url, filename }: PreviewSource): ReactElement {
    // No `sandbox` attribute, and it is measured, not an oversight: Chrome refuses to run its internal
    // PDF viewer (a MimeHandler extension) inside *any* sandboxed frame — `sandbox=""`,
    // `allow-same-origin`, and `allow-scripts allow-same-origin` all render a broken-document icon; only
    // an un-sandboxed frame shows the PDF. The isolation is the browser's PDF viewer itself: it renders
    // the bytes without ever running them as page script, which is exactly why architecture.md chose the
    // browser's viewer over rendering the PDF ourselves. The bytes are additionally pinned to
    // `application/pdf` in {@link useAttachmentSource}, so a content-type mismatch cannot smuggle markup
    // into this frame. See DECISIONS.md D-071.
    return <PdfFrameElement data-role="attachment-preview-pdf" title={filename} src={url} />;
}

const TextPane = styled.pre`
    margin: 0;
    width: 100%;
    max-width: 100%;
    overflow-x: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: ${({ theme }) => theme.colors.text.color};
    font-size: ${({ theme }) => theme.typography.fontSize.smallFontSize};
`;

function TextBlock({ blob }: PreviewSource): ReactElement | null {
    const [text, setText] = useState<string | undefined>(undefined);

    useEffect(() => {
        let live = true;
        void blob.text().then((value) => {
            if (live) {
                setText(value);
            }
        });
        return () => {
            live = false;
        };
    }, [blob]);

    if (text === undefined) {
        return null;
    }
    // `{text}` as a React child is escaped — untrusted bytes are shown as text, never as markup.
    return <TextPane data-role="attachment-preview-text">{text}</TextPane>;
}

const renderers: Record<string, AttachmentRenderer> = {
    "application/pdf": (source) => <PdfFrame {...source} />,
    "text/plain": (source) => <TextBlock {...source} />
};

/** Strip any `; charset=…` parameter and normalise case before looking a renderer up. */
function baseType(mimeType: string): string {
    return (mimeType.split(";")[0] ?? mimeType).trim().toLowerCase();
}

/**
 * Whether this MIME type has a renderer — i.e. whether previewing it produces anything. The pane that
 * hosts the preview asks first, so an unsupported type (an image, an Office file) renders *nothing at
 * all*, not an empty framed pane.
 */
export function canPreview(mimeType: string): boolean {
    return baseType(mimeType) in renderers;
}

const Status = styled(Typography.Body)`
    margin: 0;
    color: ${({ theme }) => theme.colors.text.secondaryColor};
    font-size: ${({ theme }) => theme.typography.fontSize.smallFontSize};
`;

const Refused = styled.div`
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    color: ${({ theme }) => theme.colors.text.color};
`;

const DownloadButton = styled.button`
    padding: 0;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
`;

export function AttachmentPreview(props: AttachmentPreviewProps): ReactElement | null {
    const contentType = baseType(props.mimeType);
    const renderer = renderers[contentType];
    // No renderer for this type: preview nothing, and do not mint a ticket for bytes we cannot draw.
    if (!renderer) {
        return null;
    }
    const ref: AttachmentRef = {
        docRef: props.docRef,
        documentModelName: props.documentModelName,
        attachmentId: props.attachmentId,
        filename: props.filename
    };
    return <RenderedPreview renderer={renderer} attachment={ref} contentType={contentType} />;
}

function RenderedPreview({
    renderer,
    attachment: ref,
    contentType
}: {
    renderer: AttachmentRenderer;
    attachment: AttachmentRef;
    contentType: string;
}): ReactElement {
    const source = useAttachmentSource(ref, contentType);
    const strings = previewStrings();

    if (source.state === "loading") {
        return <Status data-role="attachment-preview-loading">{strings.loading}</Status>;
    }

    if (source.state === "refused") {
        return (
            <Refused data-role="attachment-preview-refused">
                <Typography.Body>{ref.filename}</Typography.Body>
                <DownloadButton
                    type="button"
                    onClick={() => {
                        // Best-effort: if even the fresh mint fails (the store is down — the same cause
                        // as the refusal), catch it so it does not surface as an unhandled rejection.
                        downloadAttachment(ref).catch(() => undefined);
                    }}>
                    {strings.download}
                </DownloadButton>
            </Refused>
        );
    }

    return renderer(source.source);
}
