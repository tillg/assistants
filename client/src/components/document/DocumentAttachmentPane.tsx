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
 * Where the preview hangs in the form: a **full-width pane beneath the Document form**, placed by the
 * application rather than by a Form Engine `WidgetMap` entry (architecture.md's option 1 — the smaller
 * footprint, and it keeps the preview out of the form's own layout). The pane is wrapped around
 * `CustomizableRelationshipFormEngine` in {@link enginesViewMap}, so it renders only for a form, and
 * only when that form's model is the Document.
 *
 * The open document is read from the activity's default data holder (`ActivitySelectors.data`), which
 * is where a plain Document form keeps it; the relationship engine's CDD slice is the fallback for a
 * form that keeps it there instead. Either way the document is plain JSON keyed by element name, so
 * `document.Document.Attachment` is the attachment value in its snake_case persisted shape — a single
 * object when its repeatability is 1, or an array when the store expands it. This pane is a pure
 * reader: it never writes a field, dispatches an action, or takes part in validation or dirty state.
 */

import { useEffect, useRef, type ReactElement } from "react";
import { shallowEqual, useSelector } from "react-redux";
import styled from "styled-components";

import { ActivitySelectors } from "@com.mgmtp.a12.client/client-core";
import { CddSelectors } from "@com.mgmtp.a12.relationshipengine/relationshipengine-core";

import { AttachmentPreview, canPreview, type AttachmentPreviewProps } from "./AttachmentPreview";

/**
 * The preview's column in the form/preview flex row (see {@link enginesViewMap}). `flex: 1 1 480px`
 * makes it sit beside the form when both fit and take the full width when it wraps beneath on a narrow
 * window; `min-width: 0` keeps the ~A4 frame from forcing overflow. The renderers centre themselves
 * within it (`margin-inline: auto` on the PDF frame), so no width is imposed here.
 */
const Pane = styled.section`
    flex: 1 1 480px;
    min-width: 0;
`;

/** The Document model whose form carries a previewable attachment, and its root group name. */
const DOCUMENT_MODEL = "Document_DM";
const DOCUMENT_ROOT = "Document";
/** The attachment group's element name within the Document root. */
const ATTACHMENT_FIELD = "Attachment";
/** The relationship engine's technical field holding the entry docRef on the root group. */
const T_DOC_REF = "t_docRef";

/** The persisted attachment value, snake_case as it sits on the Document. */
interface AttachmentValue {
    readonly attachment_id?: string | null;
    readonly mime_type?: string | null;
    readonly original_filename?: string | null;
    readonly internal_filename?: string | null;
}

/**
 * The previewable attachment on the open Document form, or `undefined` when there is no Document form,
 * no attachment, or no stored bytes to fetch yet. Reads the activity's model and the CDD document from
 * redux, then hands the plain values to {@link previewPropsFrom} — the pure half, gating and all.
 */
function selectPreviewProps(state: object, activityId: string): AttachmentPreviewProps | undefined {
    const activity = ActivitySelectors.activityById(activityId)(state);
    if (!activity) {
        return undefined;
    }
    // A plain Document form keeps its document in the activity's default data holder; the CDD slice
    // (relationship-engine forms) is the fallback for a form that keeps it there instead.
    const plainDocument = (ActivitySelectors.data(activityId)(state) as { document?: unknown } | undefined)?.document;
    const document = (plainDocument ?? CddSelectors.cdd(activityId)(state)?.document ?? undefined) as
        Record<string, unknown> | undefined;
    return previewPropsFrom(activity.descriptor.model, activity.descriptor.instance, document);
}

/**
 * Turn a plain form model id, the docRef the form was opened with, and the plain-JSON document into
 * preview props — or `undefined`. Pure, so the gating (only a Document, only a stored attachment) is
 * tested without faking a redux store. `descriptor.instance` is the docRef; the CDD's own `t_docRef`
 * on the root group is the fallback for a document reached without one.
 */
export function previewPropsFrom(
    model: unknown,
    instance: unknown,
    document: Record<string, unknown> | undefined
): AttachmentPreviewProps | undefined {
    if (model !== DOCUMENT_MODEL) {
        return undefined;
    }
    const root = document?.[DOCUMENT_ROOT] as Record<string, unknown> | undefined;
    if (!root) {
        return undefined;
    }

    // `||`, not `??`: an empty-string `instance` (a form reached without a docRef) must fall through
    // to `t_docRef`, and an empty `t_docRef` must read as absent — a blank docRef mints a ticket that
    // is refused, showing the download fallback even when the CDD carried a usable ref.
    const docRef = (typeof instance === "string" ? instance : undefined) || asString(root[T_DOC_REF]);
    const attachment = firstStoredAttachment(root);
    if (!docRef || !attachment?.attachment_id || !attachment.mime_type) {
        return undefined;
    }

    return {
        docRef,
        documentModelName: DOCUMENT_MODEL,
        attachmentId: attachment.attachment_id,
        mimeType: attachment.mime_type,
        filename: attachment.original_filename || attachment.internal_filename || "attachment"
    };
}

function asString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

/**
 * The Document root carries the attachment group as `Attachment`; take the first that has bytes.
 * The group's read shape varies by provider — a single object when its repeatability is 1 (the
 * plain activity document), an array when the store expands it (the CDD read) — so normalise both.
 */
function firstStoredAttachment(root: Record<string, unknown>): AttachmentValue | undefined {
    const values = root[ATTACHMENT_FIELD];
    const list: AttachmentValue[] = Array.isArray(values)
        ? (values as AttachmentValue[])
        : values
          ? [values as AttachmentValue]
          : [];
    return list.find((value) => Boolean(value?.attachment_id));
}

export function DocumentAttachmentPane({ activityId }: { readonly activityId: string }): ReactElement | null {
    // `shallowEqual`: the selector builds a fresh props object each call, so without it this pane would
    // re-render on every dispatched action while any form is open. The props are flat primitives, so a
    // shallow comparison re-renders only when the previewed attachment actually changes.
    const previewProps = useSelector((state: object) => selectPreviewProps(state, activityId), shallowEqual);
    const paneRef = useRef<HTMLElement>(null);

    // Whether this attachment is one we can actually preview. An unsupported type (an image, which A12
    // already previews; an Office file) leaves the form exactly as it was, with no empty framed pane.
    const shown = previewProps !== undefined && canPreview(previewProps.mimeType) ? previewProps : undefined;
    const previewKey = shown ? `${shown.docRef}:${shown.attachmentId}` : undefined;

    // Reveal the preview when a Document opens. On a wide screen the pane already sits beside the form,
    // near the top, and nothing scrolls. On a narrower one it has wrapped beneath a full-height form,
    // below the fold — so if it starts in the lower half of the viewport, bring it into view, which is
    // the whole point of the feature (actually seeing the document). Keyed on the attachment, so it
    // fires once per Document rather than on every render.
    useEffect(() => {
        if (!previewKey) {
            return undefined;
        }
        // A short delay lets the form finish laying out first, so the measurement below reflects the
        // pane's real position rather than a half-rendered form's.
        const timer = setTimeout(() => {
            const pane = paneRef.current;
            if (pane && pane.getBoundingClientRect().top > window.innerHeight / 2) {
                pane.scrollIntoView({ block: "center", behavior: "smooth" });
            }
        }, 350);
        return () => clearTimeout(timer);
    }, [previewKey]);

    if (!shown) {
        return null;
    }
    return (
        <Pane ref={paneRef} data-role="document-attachment-preview">
            <AttachmentPreview {...shown} />
        </Pane>
    );
}
