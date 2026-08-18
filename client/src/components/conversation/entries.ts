import { format, isToday, isYesterday } from "date-fns";

/**
 * Reading a Conversation's Entries out of the JSON document the form engine already holds, and
 * grouping them the way a thread is read.
 *
 * This is a second, smaller copy of a mapping the Runtime owns (`runtime/src/a12/things.ts`). Sharing
 * that table would couple a browser bundle to a Node service for thirteen string literals, so the copy
 * is deliberate — it covers only what the Transcript renders and is tested against a document captured
 * from a running stack rather than hand-written.
 *
 * The document is read by field *name* rather than through `kernel-md-facade`'s
 * `DocumentService.getAssignedObject`. That accessor exists and works, but it would pull the kernel
 * runtime into the bundle for a single array read, and each Entry's own fields have to be read by name
 * either way.
 */

/** One Entry, in the terms the Transcript renders it. Absent fields stay absent. */
export interface TranscriptEntry {
    readonly seq: number;
    readonly at: string;
    readonly role: string;
    readonly kind: string;
    readonly text?: string;
    readonly toolName?: string;
    readonly toolArgs?: string;
    readonly toolResult?: string;
    readonly questionId?: string;
    readonly promptTokens?: number;
    readonly completionTokens?: number;
}

/** One act by an Operation: the call, and what came back. */
export interface Receipt {
    readonly type: "receipt";
    /** Absent when a result arrived with no call to attach it to — `ui.askUser`'s, or a truncated thread. */
    readonly intent?: TranscriptEntry;
    /** Absent while the call is still in flight, or when it died: an open Receipt. */
    readonly result?: TranscriptEntry;
}

/** One Entry, rendered as itself. */
export interface SingleEntry {
    readonly type: "entry";
    readonly entry: TranscriptEntry;
}

export type TranscriptItem = SingleEntry | Receipt;

/** A run of Bubbles with no separator inside it; the separator is the label above them. */
export interface Cluster {
    readonly separator: string;
    readonly items: readonly TranscriptItem[];
}

/**
 * An hour is short enough to separate a Turn from the answer that arrived after lunch, and long enough
 * that the seconds-apart Entries of one Turn stay together.
 */
const SEPARATOR_GAP_MS = 60 * 60 * 1000;

/** The Assistant asking is speech, not an Operation, so its call opens no Receipt (domain.md). */
const ASK_USER = "ui.askUser";

/** Reads the Entries of a Conversation document, in `seq` order. */
export function readEntries(document: unknown): TranscriptEntry[] {
    const entries = asRecord(asRecord(document)?.["Conversation"])?.["Entries"];
    if (!Array.isArray(entries)) {
        return [];
    }
    return entries
        .flatMap((candidate: unknown) => {
            const fields = asRecord(candidate);
            return fields === undefined ? [] : [readEntry(fields)];
        })
        .sort((left, right) => left.seq - right.seq);
}

/**
 * Groups Entries into the clusters a thread shows, pairing each call with its answer on the way.
 *
 * Pairing happens before clustering because a Receipt is one Bubble: a call that was answered an hour
 * later still belongs where it was made, and the separator falls between Bubbles rather than inside one.
 */
export function clusterEntries(entries: readonly TranscriptEntry[]): Cluster[] {
    const clusters: Cluster[] = [];
    let items: TranscriptItem[] = [];
    let previous: Date | undefined;

    for (const item of pairIntoReceipts(entries)) {
        const at = new Date(anchorOf(item).at);
        if (items.length > 0 && isSeparatorDue(previous, at)) {
            clusters.push({ separator: separatorLabel(anchorOf(items[0]!).at), items });
            items = [];
        }
        items.push(item);
        if (!Number.isNaN(at.getTime())) {
            // An instant nothing can read must not become the one the next gap is measured from. It
            // would answer "no separator due" for ever after, and the pause it swallowed is the
            // Conversation's most characteristic feature — a thread that waits ten days has to say so.
            previous = at;
        }
    }
    if (items.length > 0) {
        clusters.push({ separator: separatorLabel(anchorOf(items[0]!).at), items });
    }
    return clusters;
}

/** The text of a separator: a thread that waits for days has to say so. */
export function separatorLabel(at: string): string {
    const when = new Date(at);
    if (Number.isNaN(when.getTime())) {
        return "";
    }
    if (isToday(when)) {
        return `Today at ${format(when, "HH:mm")}`;
    }
    if (isYesterday(when)) {
        return `Yesterday at ${format(when, "HH:mm")}`;
    }
    return format(when, "EEE d MMM 'at' HH:mm");
}

function pairIntoReceipts(entries: readonly TranscriptEntry[]): TranscriptItem[] {
    const claimed = new Set<TranscriptEntry>();
    const items: TranscriptItem[] = [];

    entries.forEach((entry, index) => {
        if (claimed.has(entry)) {
            return;
        }
        if (entry.kind === "tool-intent" && entry.toolName !== ASK_USER) {
            // Pair with this call's OWN result, not a later call's. Stop the forward search at the
            // next tool-intent of the same tool: a same-tool call appearing before any result means
            // this intent died without one (in flight, or it failed). Matching purely by name let a
            // dead first call claim the second call's result — the first Receipt then showed call #1's
            // arguments beside call #2's result, and the successful call rendered as "no result".
            let result: TranscriptEntry | undefined;
            for (const later of entries.slice(index + 1)) {
                if (later.kind === "tool-intent" && later.toolName === entry.toolName) {
                    break;
                }
                if (later.kind === "tool-result" && later.toolName === entry.toolName && !claimed.has(later)) {
                    result = later;
                    break;
                }
            }
            if (result !== undefined) {
                claimed.add(result);
            }
            items.push({ type: "receipt", intent: entry, ...(result !== undefined && { result }) });
            return;
        }
        if (entry.kind === "tool-result") {
            items.push({ type: "receipt", result: entry });
            return;
        }
        items.push({ type: "entry", entry });
    });
    return items;
}

/** The Entry a Bubble is placed by: for a Receipt that is the call, because that is when the act began. */
function anchorOf(item: TranscriptItem): TranscriptEntry {
    return item.type === "entry" ? item.entry : (item.intent ?? item.result!);
}

/** `previous` is only ever a readable instant, so an unreadable `at` is the one case with no answer. */
function isSeparatorDue(previous: Date | undefined, at: Date): boolean {
    if (previous === undefined || Number.isNaN(at.getTime())) {
        return false;
    }
    return at.toDateString() !== previous.toDateString() || at.getTime() - previous.getTime() >= SEPARATOR_GAP_MS;
}

function readEntry(fields: Record<string, unknown>): TranscriptEntry {
    return {
        seq: asNumber(fields["Seq"]) ?? 0,
        at: asInstant(fields["At"]),
        role: asString(fields["Role"]) ?? "",
        kind: asString(fields["Kind"]) ?? "",
        ...optional("text", asString(fields["Text"])),
        ...optional("toolName", asString(fields["ToolName"])),
        ...optional("toolArgs", asString(fields["ToolArgs"])),
        ...optional("toolResult", asString(fields["ToolResult"])),
        ...optional("questionId", asString(fields["QuestionId"])),
        ...optional("promptTokens", asNumber(fields["PromptTokens"])),
        ...optional("completionTokens", asNumber(fields["CompletionTokens"]))
    };
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
    return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function asString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

/**
 * An instant, from either shape the same field arrives in.
 *
 * The ThingStore's JSON gives `At` as the string A12 stores — `2026-08-16T13:07:16`. The **form
 * engine** does not: it parses a `DateTimeType` into a JavaScript `Date` before the document
 * reaches a component. So the same Entry is a string in the captured fixture and a `Date` in the
 * running application, and reading it with `asString` alone silently yielded `""` — which made
 * every instant unreadable, every separator empty, and therefore **no separator ever appeared in
 * the real application**, while the unit tests over the fixture passed. Found end to end, because
 * only the end-to-end tier sees the shape the form engine actually hands over.
 */
function asInstant(value: unknown): string {
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? "" : value.toISOString();
    }
    return asString(value) ?? "";
}

function asNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
