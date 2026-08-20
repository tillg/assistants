import { transcriptLanguage } from "./localize";

/**
 * A **Thing Label** is how a Thing is named on screen: its own title, and (separately) its Model in
 * brackets. Neither is stored on the Thing — ADR-0002, *a ThingID identifies and nothing more* — so both
 * are composed here by the reader, off the document `useThingById` already returns.
 *
 * There is no single "title" field. Each subject Model carries its human identity differently, so this
 * module *is* domain.md's per-Model table as code. Invoice is the awkward one — an invoice's identity to
 * a human is who sent it and its number — which is why this is a named concept rather than a field read.
 *
 * Every branch ends at `shortId(thingId)`: a Thing whose fields are all empty degrades to roughly what
 * the header showed before this change, never to blank.
 */

/** The localized Model names the bracket uses. A small, closed set — a Model outside it gets no bracket. */
const MODEL_LABELS: Readonly<Record<"en" | "de", Readonly<Record<string, string>>>> = {
    // Values mirror each DM header's own singular label (Process → Vorgang, Party → Kontakt in German).
    en: {
        Document_DM: "Document",
        Invoice_DM: "Invoice",
        Process_DM: "Process",
        Party_DM: "Party",
        Conversation_DM: "Conversation"
    },
    de: {
        Document_DM: "Dokument",
        Invoice_DM: "Rechnung",
        Process_DM: "Vorgang",
        Party_DM: "Kontakt",
        Conversation_DM: "Konversation"
    }
};

/** The Model's localized display name, or `undefined` for a Model outside the closed set. */
export function modelLabel(model: string): string | undefined {
    return MODEL_LABELS[transcriptLanguage()][model];
}

/** The Thing's own title, per its Model — falling back to a short id when no field yields anything. */
export function thingLabel(model: string, document: unknown, thingId: string): string {
    const fields = asRecord(asRecord(document)?.[model.replace(/_DM$/, "")]);
    const fallback = shortId(thingId);

    switch (model) {
        case "Document_DM":
        case "Process_DM":
        case "Conversation_DM":
            return str(fields?.["Title"]) || fallback;
        case "Party_DM":
            return str(fields?.["Name"]) || str(fields?.["LegalName"]) || fallback;
        case "Invoice_DM":
            return invoiceLabel(fields) || fallback;
        default:
            return fallback;
    }
}

/** *IssuerName · #InvoiceNumber*, or whichever of the two is present, then `Subject` — else nothing. */
function invoiceLabel(fields: Record<string, unknown> | undefined): string {
    const issuer = str(fields?.["IssuerName"]);
    const number = str(fields?.["InvoiceNumber"]);
    const composed = [issuer, number ? `#${number}` : ""].filter((part) => part !== "").join(" · ");
    return composed || str(fields?.["Subject"]);
}

/** Enough of a ThingID to recognise it by — the shared fallback for every Label, and the header's own. */
export function shortId(thingId: string): string {
    return thingId.slice(0, 8);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function str(value: unknown): string {
    return typeof value === "string" ? value : "";
}
