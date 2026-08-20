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
 * Byte delivery for an attachment preview — the mime-agnostic half of the feature.
 *
 * The platform mints a **single-use download ticket** per call: `retrieveDownloadLink` returns an
 * absolute URL `http://…:8082/cs/download/<ticket>?filename=…`. That URL is unusable as an
 * `<iframe src>` for two measured reasons — it is cross-origin (CORS blocks reading it into JS) and
 * it is served `Content-Disposition: attachment` (a live iframe downloads the file instead of
 * showing it). Both dissolve if the bytes are fetched **same-origin** and handed to the browser as a
 * blob URL: nginx (and the webpack dev server) proxy `/cs` to the store, so keeping only the ticket
 * URL's path makes the request same-origin, and a blob URL the app created renders inline whatever
 * the original disposition header said.
 *
 * This hook owns exactly one object URL and revokes it on unmount and whenever the attachment
 * changes — a 175 KB invoice leaked per Document view is the kind of leak nobody notices until a
 * long session. It never branches on file type: it re-serves any content-type, and only the
 * renderer (see {@link AttachmentPreview}) cares whether the bytes are a PDF or text.
 */

import { useEffect, useState } from "react";

import { platformAttachmentLoader } from "@com.mgmtp.a12.formengine/formengine-core";

/** The persisted attachment identity plus the Document that owns it — everything a mint needs. */
export interface AttachmentRef {
    readonly docRef: string;
    readonly documentModelName: string;
    readonly attachmentId: string;
    readonly filename: string;
}

/** Bytes reachable by the browser: the blob itself (text renderers decode it) and an object URL for it. */
export interface PreviewSource {
    readonly blob: Blob;
    readonly url: string;
    readonly filename: string;
}

export type SourceState =
    | { readonly state: "loading" }
    | { readonly state: "ready"; readonly source: PreviewSource }
    | { readonly state: "refused" };

type LoaderAttachment = Parameters<typeof platformAttachmentLoader.retrieveDownloadLink>[0];
type LoaderDescriptor = Parameters<typeof platformAttachmentLoader.retrieveDownloadLink>[1];

function mint(ref: AttachmentRef): Promise<string> {
    return platformAttachmentLoader.retrieveDownloadLink(
        { attachment_id: ref.attachmentId } as LoaderAttachment,
        {
            documentId: ref.docRef,
            documentModelName: ref.documentModelName
        } as LoaderDescriptor
    );
}

/**
 * Reduce the platform's cross-origin ticket URL to a same-origin path so `fetch` may read it. An
 * already-relative location is returned unchanged; only the origin is dropped.
 */
export function toSameOriginPath(location: string): string {
    const url = new URL(location, window.location.origin);
    return url.pathname + url.search;
}

export function useAttachmentSource(ref: AttachmentRef, contentType: string): SourceState {
    const { docRef, documentModelName, attachmentId, filename } = ref;
    const [result, setResult] = useState<SourceState>({ state: "loading" });

    useEffect(() => {
        let cancelled = false;
        let objectUrl: string | undefined;
        setResult({ state: "loading" });

        void (async () => {
            try {
                const location = await mint({ docRef, documentModelName, attachmentId, filename });
                const response = await fetch(toSameOriginPath(location));
                if (!response.ok) {
                    throw new Error(`attachment fetch failed: ${response.status}`);
                }
                // Re-type the bytes to the MIME type the dispatcher chose, rather than trusting the
                // store's response header. The PDF frame is not sandboxed (the browser's PDF viewer
                // refuses to run inside a sandbox), so a file the store served as `text/html` would
                // otherwise be script in a same-origin frame. Pinning the blob type makes the browser
                // treat the bytes as the declared type — a hostile mismatch renders as a broken PDF,
                // never as markup.
                const blob = new Blob([await response.blob()], { type: contentType });
                if (cancelled) {
                    return;
                }
                objectUrl = URL.createObjectURL(blob);
                setResult({ state: "ready", source: { blob, url: objectUrl, filename } });
            } catch {
                // A spent ticket, a CORS refusal, a dead store — any of them degrades to the filename
                // and a download, which is the behaviour the preview replaced.
                if (!cancelled) {
                    setResult({ state: "refused" });
                }
            }
        })();

        return () => {
            cancelled = true;
            if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
            }
        };
    }, [docRef, documentModelName, attachmentId, filename, contentType]);

    return result;
}

/**
 * Mint a fresh ticket and let the browser download it — the refused-state fallback and a plain
 * re-do of the platform's own Download action. A fresh ticket every time: the one behind the
 * preview is spent, and the store answers `404` to a replayed ticket.
 */
export async function downloadAttachment(ref: AttachmentRef): Promise<void> {
    const location = await mint(ref);
    window.open(location, "_blank", "noopener,noreferrer");
}
