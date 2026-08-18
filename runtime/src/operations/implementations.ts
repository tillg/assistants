/**
 * Every Operation the Assistants can reach.
 *
 * The shape to notice: **any Operation may answer `pending`**. Coding agents assume a call returns in
 * seconds and block inside the Turn; our Operations are human-paced by design — a Manual
 * Connector, a question to the User, a call to another Assistant — so the pending path is the
 * normal path, not the exception. That single generalisation is what turns a coding-agent loop
 * into this one.
 */

import { log } from "../log.js";
import { ThingRepository, SPECS, byCreatedAt, nowIso, path as fieldPath, eq } from "../a12/things.js";
import type { ModelSpec } from "../a12/things.js";
import { FireflyError } from "../connectors/firefly.js";
import type { FireflyConnector, PostingSplit } from "../connectors/firefly.js";
import type { OperationContext, OperationImplementation, OperationOutcome } from "./registry.js";
import { isAnswered } from "../watcher/watcher.js";
import { readTextLayer } from "../readers/textLayer.js";
import { NULL_VISION_READER, type VisionReader } from "../llm/vision.js";
import {
    isTriggerEligible,
    type Assistant,
    type Conversation,
    type DocumentThing,
    type OpenQuestion,
    type ThingModel,
} from "../domain/types.js";

/**
 * The half of the Content Store client the two document readers use.
 *
 * Narrower than {@link ContentStoreClient} on purpose: these Operations read bytes and never write
 * any, so the type they take says so — and a test can hand them a function rather than a client.
 */
export interface AttachmentDownloader {
    download(attachmentId: string): Promise<Buffer>;
}

/** The caps `document.readScan` refuses over, from {@link Config}. */
export interface VisionLimits {
    visionMaxPages: number;
    visionMaxBytes: number;
}

export interface OperationDeps {
    things: ThingRepository;
    firefly: FireflyConnector;
    /**
     * The Content Store, for the two readers.
     *
     * Optional because the Runtime does not build one yet — `services.ts` constructs no
     * {@link ContentStoreClient}, and threading one in is that file's change rather than this one's.
     * Absent, both readers say so in words instead of failing obscurely on a missing method.
     */
    content?: AttachmentDownloader;
    /** The `vision` profile's reader, or the null one — which is the shipped default. */
    vision?: VisionReader;
    /** Defaults matching `config.ts`, so a caller that has no Config still gets bounded reads. */
    limits?: VisionLimits;
    /** Raise an Open Question and return its ThingID. Shared by askUser and every Manual Connector. */
    raiseQuestion(input: {
        context: OperationContext;
        kind: "free-text" | "confirm" | "choice" | "perform";
        prompt: string;
        options?: Array<{ value: string; label: string }>;
        subjectThingId?: string;
    }): Promise<string>;
    /** Birth a child Conversation for another Assistant. */
    callAssistant(input: {
        context: OperationContext;
        assistantKey: string;
        prompt: string;
        subjectThingId?: string;
        subjectModel?: string;
    }): Promise<string>;
}

const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });

/**
 * The store's own ceiling on an `exact_match` value, measured: 101 characters is refused with
 * "Please reduce the input value length to a value lower than 100 for the exact_match operator."
 * Note this is *shorter* than the 200-character fields it is used to search, so a legal field value
 * can be an illegal search term.
 */
const EXACT_MATCH_MAX_LENGTH = 100;

/** The store refuses a `pageSize` above this, so it is a hard ceiling and not a preference. */
const PAGE_SIZE_MAX = 100;

/**
 * A calendar date, and nothing else — the shape every date argument on the Bookkeeping Operations is
 * documented to take. Anchored at both ends deliberately: an unanchored pattern would accept a date
 * with something appended to it, which is exactly the trailing junk this refuses.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The most transactions one call will fetch. A ceiling rather than a default, because the Operation
 * is `clientReadable` and its answer is assembled in memory in the process that runs the scan loop.
 */
const TRANSACTIONS_LIMIT_MAX = 200;

/**
 * Firefly's field names, in the vocabulary the model was actually given.
 *
 * The model only ever handles account *names* — `bookkeeping.listAccounts` returns names and the
 * connector resolves them to ids on the way out — so a 422 about `transactions.0.source_id` is
 * about a field it has no word for, quoting a number it has never seen.
 */
const FIREFLY_FIELD_NAMES: Record<string, keyof PostingSplit> = {
    source_id: "sourceAccount",
    source_name: "sourceAccount",
    destination_id: "destinationAccount",
    destination_name: "destinationAccount",
    budget_name: "budgetName",
    category_id: "categoryName",
    category_name: "categoryName",
    currency_code: "currencyCode",
    amount: "amount",
    date: "date",
    description: "description",
    type: "type",
    notes: "notes",
};

/**
 * A Firefly rejection, rewritten for the model that caused it.
 *
 * `details.errors` is keyed `transactions.<index>.<field>`, so the split and the field are both
 * recoverable — and once the field is known, so is the value the model supplied for it, which is
 * what replaces the internal id in Firefly's own sentence.
 */
function describeRejection(error: FireflyError, splits: PostingSplit[]): string {
    const errors = (error.details as { errors?: Record<string, string[]> } | undefined)?.errors;
    if (!errors || Object.keys(errors).length === 0) return error.message;

    const lines = new Set<string>();
    for (const [key, messages] of Object.entries(errors)) {
        const match = /^transactions\.(\d+)\.(.+)$/.exec(key);
        const index = match ? Number(match[1]) : 0;
        const field = match ? match[2]! : key;
        const property = FIREFLY_FIELD_NAMES[field];
        const supplied = property ? splits[index]?.[property] : undefined;
        const label = property ?? field;
        const where = splits.length > 1 ? ` (posting ${index + 1})` : "";
        const said = messages
            .join(" ")
            // The internal id, replaced by the name the model actually gave.
            .replace(/ID "\d+"/g, supplied ? `"${String(supplied)}"` : "that account")
            .replace(/ or name ""\.?/g, "");
        lines.add(
            `${label}${where}${supplied === undefined ? "" : ` "${String(supplied)}"`}: ${said.trim()}`,
        );
    }
    return `Firefly refused this posting.\n${[...lines].map((line) => `- ${line}`).join("\n")}`;
}

/**
 * The property that identifies a row within a repeating group.
 *
 * Merging by a key rather than appending is what makes both realistic model moves correct: "add
 * step 4", and "here is the whole list again with step 4 on the end" — which is what a model that
 * read the Thing first will send. A blind append would duplicate every row in the second case.
 * A group with no key here is appended to, which is the safe default.
 */
const GROUP_ROW_KEYS: Record<string, string> = {
    steps: "seq",
    related: "thingId",
};

/**
 * Merge supplied rows into the rows already stored.
 *
 * A row whose key matches replaces that row; a row with a new key is added; a row that is not
 * mentioned is kept. An empty array therefore changes nothing — an empty array is not an
 * instruction to forget, and treating it as one silently emptied the group.
 */
function mergeRows(group: string, existing: unknown, supplied: unknown): unknown[] {
    const before = Array.isArray(existing) ? (existing as Record<string, unknown>[]) : [];
    const incoming = Array.isArray(supplied) ? (supplied as Record<string, unknown>[]) : [];
    if (incoming.length === 0) return before;

    const key = GROUP_ROW_KEYS[group];
    if (!key) return [...before, ...incoming];

    const out = [...before];
    for (const row of incoming) {
        const identity = row[key];
        const at =
            identity === undefined
                ? -1
                : out.findIndex((candidate) => String(candidate[key]) === String(identity));
        if (at === -1) out.push(row);
        else out[at] = { ...out[at], ...row };
    }
    return out;
}

/** One Firefly transaction group, reduced to the fields an Accountant reasons about. */
function projectTransactionGroup(group: Record<string, unknown>): Array<Record<string, unknown>> {
    const attributes = (group["attributes"] ?? {}) as Record<string, unknown>;
    const splits = (attributes["transactions"] ?? []) as Array<Record<string, unknown>>;
    return splits.map((split) => ({
        transactionId: group["id"],
        date: String(split["date"] ?? "").slice(0, 10),
        description: split["description"],
        amount: split["amount"],
        currency: split["currency_code"],
        from: split["source_name"],
        to: split["destination_name"],
        category: split["category_name"] ?? undefined,
        budget: split["budget_name"] ?? undefined,
        // The two links back to our own world: the idempotency key, and the Invoice's ThingID.
        bookedUnderKey: split["external_id"] ?? undefined,
        tags: split["tags"] ?? undefined,
    }));
}

/**
 * How a booking reads in the approval question.
 *
 * This is the entire user-facing surface of *"nothing is booked without an answer"*, so it is a
 * sentence rather than a record: amount, where the money comes from, where it goes, the date, and
 * what it is for. A User who is shown a JSON blob learns to click yes without reading it, which is
 * how a safety feature becomes a formality.
 */
function describePosting(args: Record<string, unknown>): string {
    const splits = Array.isArray(args["splits"]) ? (args["splits"] as PostingSplit[]) : [];
    // A model that emitted `splits` as a JSON string, or omitted it, gets the JSON fallback rather
    // than a confident sentence about nothing. "Book a transaction with no postings?" is a safety
    // question that describes no posting, which is worse than showing the User the raw call — the
    // call is going to be refused by `execute` either way, and the fallback exists for exactly this.
    if (splits.length === 0) return "";

    // "€96.50 from *Payables* to *Expenses:Health*, dated …, for …" — the money and the two accounts
    // are one phrase, so the commas fall where a reader would pause rather than after the verb.
    const posting = (split: PostingSplit) =>
        [
            `${money(split.amount, split.currencyCode)} ` +
                `from *${split.sourceAccount || "(no source)"}* ` +
                `to *${split.destinationAccount || "(no destination)"}*`,
            split.date ? `dated ${split.date}` : undefined,
            split.description ? `for ${split.description}` : undefined,
        ]
            .filter(Boolean)
            .join(", ");

    if (splits.length === 1) return `Book ${posting(splits[0]!)}?`;
    // The verb goes in the question and not in every bullet, so a list of postings reads as a list.
    return [
        `Book ${splits.length} postings${args["groupTitle"] ? ` under *${String(args["groupTitle"])}*` : ""}?`,
        ``,
        ...splits.map((split) => `- ${posting(split)}`),
    ].join("\n");
}

/** `€96.50`, or `96.50 CHF` when it is not the currency the household keeps its books in. */
function money(amount: unknown, currencyCode: unknown): string {
    const value = String(amount ?? "?");
    const currency = String(currencyCode ?? "EUR").toUpperCase();
    return currency === "EUR" ? `€${value}` : `${value} ${currency}`;
}

/**
 * The current calendar month, as Firefly wants it.
 *
 * Firefly rejects `start === end` ("The start must be a date before end"), so a period always spans
 * the whole month rather than a single day.
 */
function currentMonth(): { start: string; end: string } {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

/** `chase` also wakes the caller after five minutes to check; `wait` and `detach` do not. */
function chaseWakeAt(awaitMode: string): string | undefined {
    return awaitMode === "chase" ? nowIso(new Date(Date.now() + 5 * 60_000)) : undefined;
}

function specFor(model: string): ModelSpec {
    const spec = (SPECS as Record<string, ModelSpec>)[model];
    if (!spec) {
        throw new Error(
            `Unknown model "${model}". Known models: ${Object.keys(SPECS).join(", ")}`,
        );
    }
    return spec;
}

/**
 * Models an Assistant may **read**.
 *
 * Everything the Runtime knows about except the catalogue: `Operation_DM` is the one Model whose
 * entire content is the safety configuration constraining the reader, and an Assistant learns what
 * it may do from the schemas it is offered, which is ADR-0010's design.
 */
const READABLE_MODELS: readonly string[] = Object.keys(SPECS).filter(
    (model) => model !== "Operation_DM",
);

/** Models an Assistant may create or edit. Never its own machinery. */
const WRITABLE_MODELS: readonly string[] = ["Party_DM", "Document_DM", "Invoice_DM", "Process_DM"];

/**
 * `Document_DM` with its attachment group readable.
 *
 * `SPECS.Document_DM` deliberately leaves the group out: `ThingRepository.update` merges onto the
 * **raw** stored document precisely so the projection does not have to know about it, and adding it
 * there would put an attachment in front of every writer that has never wanted one.
 *
 * Reading it needs one value, so the group is mapped here as if it were a scalar field:
 * `fromDocument` copies `Document/Attachment` across untouched, whatever shape the store hands it
 * back in. Read-only — nothing writes through this spec, and the readers update through
 * `SPECS.Document_DM` as everything else does.
 */
export const DOCUMENT_WITH_ATTACHMENT: ModelSpec = {
    ...SPECS.Document_DM,
    fields: { ...SPECS.Document_DM.fields, attachment: "Attachment" },
};

/** The attachment group of a `Document_DM`, in the platform's own snake_case field names. */
interface StoredAttachment {
    attachment_id?: string;
    original_filename?: string;
    mime_type?: string;
    size?: number;
}

/**
 * The attachment on a Document, or `undefined` when it has none.
 *
 * The group is `repeatability: 1`, so the store holds it as a single object; a one-row array is
 * accepted as well rather than trusting that observation with the whole reading ladder behind it.
 * An attachment with no `attachment_id` is inline `content` — which nothing in this system creates,
 * and which there is nothing to download for.
 */
function attachmentOf(data: Record<string, unknown>): StoredAttachment | undefined {
    const group = data["attachment"];
    const row = Array.isArray(group) ? group[0] : group;
    if (typeof row !== "object" || row === null) return undefined;
    const attachment = row as StoredAttachment;
    return attachment.attachment_id ? attachment : undefined;
}

/**
 * The caps' defaults, matching `config.ts`. Repeated rather than imported because these Operations
 * take their limits as an argument and a caller with no Config — a test, the bootstrap CLI — should
 * still get a bounded read rather than an unbounded one.
 */
const VISION_LIMIT_DEFAULTS: VisionLimits = {
    visionMaxPages: 10,
    visionMaxBytes: 16 * 1024 * 1024,
};

export function buildOperations(deps: OperationDeps): OperationImplementation[] {
    const { things, firefly } = deps;
    const vision = deps.vision ?? NULL_VISION_READER;
    const limits = deps.limits ?? VISION_LIMIT_DEFAULTS;

    const thingstoreCreate: OperationImplementation = {
        name: "thingstore.create",
        mutating: true,
        seed: {
            name: "Create a Thing",
            system: "ThingStore",
            kind: "internal",
            description:
                "Create a new Thing in the ThingStore. Returns its ThingID. Safe to retry: a repeated " +
                "call within the same turn returns the Thing already created rather than a duplicate.",
            parameters: {
                type: "object",
                properties: {
                    model: str(`Which Model to create. One of: ${WRITABLE_MODELS.join(", ")}.`),
                    fields: {
                        type: "object",
                        description: "The Thing's fields, as camelCase property names.",
                        additionalProperties: true,
                    },
                },
                required: ["model", "fields"],
            },
        },
        async execute(args, context): Promise<OperationOutcome> {
            const model = String(args["model"] ?? "");
            if (!WRITABLE_MODELS.includes(model)) {
                return {
                    kind: "error",
                    message: `Assistants may not create ${model}. Allowed: ${WRITABLE_MODELS.join(", ")}.`,
                };
            }
            const fields = (args["fields"] ?? {}) as Record<string, unknown>;
            const created = await things.create(specFor(model), {
                ...fields,
                idempotencyKey: context.idempotencyKey,
                createdByConversationId: context.conversation.thingId,
            });
            log.info("thing created", { model, thingId: created.thingId });
            return { kind: "value", value: { thingId: created.thingId, model } };
        },
        async reconcile(args, context): Promise<OperationOutcome | undefined> {
            const model = String(args["model"] ?? "");
            if (!WRITABLE_MODELS.includes(model)) return { kind: "value", value: null };
            const existing = await things.findByIdempotencyKey(
                specFor(model),
                context.idempotencyKey,
            );
            return existing
                ? { kind: "value", value: { thingId: existing.thingId, model } }
                : { kind: "error", message: "This call was interrupted and nothing was created; try again." };
        },
    };

    const thingstoreGet: OperationImplementation = {
        name: "thingstore.get",
        mutating: false,
        seed: {
            name: "Read a Thing",
            system: "ThingStore",
            kind: "internal",
            description: "Read one Thing by its Model and ThingID.",
            parameters: {
                type: "object",
                properties: { model: str("The Model, e.g. Invoice_DM."), thingId: str("The ThingID.") },
                required: ["model", "thingId"],
            },
        },
        async execute(args): Promise<OperationOutcome> {
            const model = String(args["model"] ?? "");
            if (!READABLE_MODELS.includes(model)) {
                return {
                    kind: "error",
                    message: `Assistants may not read ${model}. Readable: ${READABLE_MODELS.join(", ")}.`,
                };
            }
            const thingId = String(args["thingId"] ?? "");
            const found = await things.get(specFor(model), `${model}/${thingId}`);
            return { kind: "value", value: { thingId: found.thingId, model, fields: found.data } };
        },
    };

    const thingstoreUpdate: OperationImplementation = {
        name: "thingstore.update",
        mutating: true,
        seed: {
            name: "Update a Thing",
            system: "ThingStore",
            kind: "internal",
            description:
                "Update fields on an existing Thing. Supply only the fields you are changing; the " +
                "others are preserved. Rows of a repeating list (a Process's steps, its related " +
                "Things) are merged, not replaced: supply just the row you are adding or correcting. " +
                "Nothing is ever removed from a list.",
            parameters: {
                type: "object",
                properties: {
                    model: str("The Model."),
                    thingId: str("The ThingID."),
                    fields: {
                        type: "object",
                        description: "Fields to change.",
                        additionalProperties: true,
                    },
                },
                required: ["model", "thingId", "fields"],
            },
        },
        async execute(args, context): Promise<OperationOutcome> {
            const model = String(args["model"] ?? "");
            if (!WRITABLE_MODELS.includes(model)) {
                return {
                    kind: "error",
                    message: `Assistants may not update ${model}. Allowed: ${WRITABLE_MODELS.join(", ")}.`,
                };
            }
            const spec = specFor(model);
            const docRef = `${model}/${String(args["thingId"] ?? "")}`;
            const current = await things.get<Record<string, unknown>>(spec, docRef);
            const fields = (args["fields"] ?? {}) as Record<string, unknown>;
            // Only what was asked for. `ThingRepository.update` merges over the *current* document,
            // so sending the whole snapshot read a moment ago would revert anything saved in between
            // — it preserves the other fields as they were at the read, which is not what "the others
            // are preserved" means to anyone reading it.
            // Machine fields are the store's to write, never the model's. `thingstore.create`
            // overrides `idempotencyKey` / `createdByConversationId` after its spread; `update` has to
            // strip them, or an Assistant could rewrite a Thing's dedup and provenance anchors — which
            // crash recovery (`findByIdempotencyKey`, the create / assistant.call reconcilers) keys
            // off — just by naming the field. `updatedAt` is force-stamped by `update` regardless.
            const MACHINE_FIELD_KEYS = ["idempotencyKey", "createdByConversationId", "createdAt", "updatedAt"];
            const merged: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(fields)) {
                if (!MACHINE_FIELD_KEYS.includes(key)) merged[key] = value;
            }
            // Repeating groups are merged row by row, not replaced. A plain spread made "add step 4"
            // destroy steps 1 to 3 — on the one list README calls append-only — and reported success.
            // These need the stored rows, which is the one thing worth re-reading for.
            for (const group of Object.keys(spec.groups ?? {})) {
                if (!(group in fields)) continue;
                merged[group] = mergeRows(group, current.data[group], fields[group]);
            }
            await things.update(spec, docRef, merged);
            void context;
            return { kind: "value", value: { thingId: current.thingId, model, updated: true } };
        },
        async reconcile(): Promise<OperationOutcome> {
            // An update sets named fields to values the model chose, so applying it twice reaches
            // the same state. Reporting the uncertainty is enough; the next Turn can re-read.
            return {
                kind: "error",
                message:
                    "This update was interrupted and may or may not have applied. Read the Thing back before assuming either way.",
            };
        },
    };

    const thingstoreSearch: OperationImplementation = {
        name: "thingstore.search",
        mutating: false,
        seed: {
            name: "Find Things",
            system: "ThingStore",
            kind: "internal",
            description:
                "Find Things of one Model. Without a field filter it returns the most recent ones. " +
                "Filtering matches a field exactly.",
            parameters: {
                type: "object",
                properties: {
                    model: str("The Model to search."),
                    field: str("Optional: the camelCase property to filter on."),
                    value: str("Optional: the exact value that field must have."),
                    limit: num("Maximum results (default 25)."),
                },
                required: ["model"],
            },
        },
        async execute(args): Promise<OperationOutcome> {
            const model = String(args["model"] ?? "");
            if (!READABLE_MODELS.includes(model)) {
                return {
                    kind: "error",
                    message: `Assistants may not read ${model}. Readable: ${READABLE_MODELS.join(", ")}.`,
                };
            }
            const spec = specFor(model);
            const field = args["field"] ? String(args["field"]) : undefined;
            // `|| 25` only catches falsy values, so a negative or fractional limit used to reach the
            // store as-is and come back an opaque RPC error the model cannot act on. Clamp to a
            // positive integer first, as listTransactions already does; the upper bound below is a
            // deliberate error, not a silent clamp.
            const requested = Number(args["limit"] ?? 25);
            const limit = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 25;
            if (limit > PAGE_SIZE_MAX) {
                // Clamping silently was the bug: a model that asked for everything, got a hundred
                // rows and was told nothing has no way to know it did not see everything.
                return {
                    kind: "error",
                    message:
                        `${limit} is more than one page. The most this returns is ${PAGE_SIZE_MAX} — ` +
                        `ask for ${PAGE_SIZE_MAX} or fewer, or narrow it with a field filter.`,
                };
            }
            if (field !== undefined && !spec.fields[field]) {
                // The only search that genuinely cannot work is one naming a field the Model does
                // not have — that is an RPC error the model cannot recover from. An earlier
                // version rejected anything without the `indexed` annotation, which was measured
                // to be wrong: `exact_match` filters correctly on unindexed scalars too, and the
                // check refused 25 legitimate searches, including "which invoices are overdue".
                return {
                    kind: "error",
                    message:
                        `"${field}" is not a field of ${model}. Fields: ` +
                        `${Object.keys(spec.fields).join(", ")}.`,
                };
            }
            const value = String(args["value"] ?? "");
            if (field !== undefined && value === "") {
                // `value` is optional in this Operation's schema, so omitting it is a permitted call —
                // and an `exact_match` with an empty value is not "no filter". The store cannot
                // build a predicate from it and answers a bare -32057 whose own description is
                // "Unexpected error during query execution.", so this has to be caught here.
                //
                // Deliberately NOT mapped to `undefined_match`: that asks "is the field empty",
                // a different question, and silently answering a different question is worse than
                // refusing.
                return {
                    kind: "error",
                    message:
                        `Searching ${model} by "${field}" needs a value to match. ` +
                        `Leave "field" out entirely to list Things instead.`,
                };
            }
            if (field !== undefined && value.length > EXACT_MATCH_MAX_LENGTH) {
                return {
                    kind: "error",
                    message:
                        `That value is ${value.length} characters; ${model} can only be searched ` +
                        `by a value of up to ${EXACT_MATCH_MAX_LENGTH}.`,
                };
            }
            const constraint = field !== undefined ? eq(fieldPath(spec, field), value) : undefined;
            // Newest first, which is what the description has always claimed. Without a sort the
            // store returns an arbitrary window, so "the most recent ones" was not merely
            // unordered — it was untrue, and a model searching for one Thing among more than
            // `limit` matches concluded it did not exist.
            const found = await things.search<Record<string, unknown>>(
                spec,
                constraint,
                limit,
                byCreatedAt(spec, "DESC"),
            );
            return {
                kind: "value",
                value: found.map((thing) => ({ thingId: thing.thingId, model, fields: thing.data })),
            };
        },
    };

    const askUser: OperationImplementation = {
        name: "ui.askUser",
        mutating: true,
        seed: {
            name: "Ask the User",
            system: "UserInterface",
            kind: "internal",
            description:
                "Ask the User a question and stop until they answer. Use this for any decision that is " +
                "the User's to make — approving a booking, resolving an ambiguity, confirming a total. " +
                "The conversation suspends; you will be resumed with the answer.",
            parameters: {
                type: "object",
                properties: {
                    kind: {
                        type: "string",
                        enum: ["free-text", "confirm", "choice"],
                        description:
                            "free-text for open answers, confirm for yes/no, choice for a list.",
                    },
                    prompt: str("The question, in markdown. Give the User the context they need."),
                    options: {
                        type: "array",
                        description: "For kind=choice: the options to offer.",
                        items: {
                            type: "object",
                            properties: { value: { type: "string" }, label: { type: "string" } },
                            required: ["value", "label"],
                        },
                    },
                    subjectThingId: str("Optional: the Thing this question is about."),
                },
                required: ["kind", "prompt"],
            },
        },
        async execute(args, context): Promise<OperationOutcome> {
            const kind = String(args["kind"] ?? "free-text");
            // The schema's enum is not enforced by the runtime, and `raiseQuestion` also accepts
            // "perform" — the surface reserved for granted manual connectors (bank.sendMoney, …). An
            // Assistant granted none of those could otherwise mint a "please do this by hand" question
            // just by naming the kind, so the enum is checked here.
            if (kind !== "free-text" && kind !== "confirm" && kind !== "choice") {
                return { kind: "error", message: `Unknown question kind "${kind}". Use free-text, confirm or choice.` };
            }
            const prompt = String(args["prompt"] ?? "").trim();
            if (!prompt) return { kind: "error", message: "A question needs a prompt." };
            const questionId = await deps.raiseQuestion({
                context,
                kind,
                prompt,
                options: (args["options"] as Array<{ value: string; label: string }>) ?? undefined,
                subjectThingId: args["subjectThingId"] ? String(args["subjectThingId"]) : undefined,
            });
            return { kind: "pending", waitingFor: "user", questionId };
        },
        async reconcile(_args, context): Promise<OperationOutcome | undefined> {
            const existing = await things.findByIdempotencyKey<OpenQuestion>(
                SPECS.OpenQuestion_DM,
                context.idempotencyKey,
            );
            if (!existing) return undefined;
            // `isAnswered`, not `answeredAt` — the same rule the watcher's scan uses. Nothing stamps
            // the timestamp, so keying on it here meant recovery and the scan held two different
            // answers to "has the User answered?" for one question.
            return isAnswered(existing.data)
                ? { kind: "value", value: { answered: true } }
                : { kind: "pending", waitingFor: "user", questionId: existing.thingId };
        },
    };

    const assistantCall: OperationImplementation = {
        name: "assistant.call",
        mutating: true,
        seed: {
            name: "Call another Assistant",
            system: "Runtime",
            kind: "internal",
            description:
                "Ask another Assistant to do something. The call is asynchronous: a new conversation is " +
                "started for them, and you are resumed when they finish.",
            parameters: {
                type: "object",
                properties: {
                    prompt: str("What you are asking them to do, in markdown."),
                    subjectThingId: str("Optional: the Thing the work is about."),
                    subjectModel: str("Optional: that Thing's Model."),
                    awaitMode: {
                        type: "string",
                        enum: ["wait", "chase", "detach"],
                        description:
                            "wait: resume when they finish. chase: also wake after 5 minutes to check. " +
                            "detach: do not wait for them at all.",
                    },
                },
                required: ["prompt"],
            },
        },
        async execute(args, context): Promise<OperationOutcome> {
            const assistantKey = String(args["assistantKey"] ?? "");
            if (!assistantKey) {
                return { kind: "error", message: "assistant.call must name the Assistant to call." };
            }
            if (assistantKey === context.assistant.data.key) {
                return { kind: "error", message: "An Assistant may not call itself." };
            }
            // The callee has to be able to run, or the birth strands both Conversations somewhere
            // no scan can reach — which is the disappearance ADR-0015 forbids. Checked here rather
            // than in `callAssistant` so it is a tool error the model can act on, and so the unit
            // suite (which supplies its own `callAssistant`) actually exercises it.
            const [callee] = await things.search<Assistant>(
                SPECS.Assistant_DM,
                eq(fieldPath(SPECS.Assistant_DM, "key"), assistantKey),
                2,
            );
            if (!callee) {
                return { kind: "error", message: `There is no Assistant with key "${assistantKey}".` };
            }
            if (callee.data.enabled === false) {
                return {
                    kind: "error",
                    message:
                        `The "${assistantKey}" assistant is disabled, so it cannot be called and ` +
                        `nothing would ever pick the work up. Do it yourself, or ask the User.`,
                };
            }
            const childId = await deps.callAssistant({
                context,
                assistantKey,
                prompt: String(args["prompt"] ?? ""),
                subjectThingId: args["subjectThingId"] ? String(args["subjectThingId"]) : undefined,
                subjectModel: args["subjectModel"] ? String(args["subjectModel"]) : undefined,
            });
            const awaitMode = String(args["awaitMode"] ?? "wait");
            if (awaitMode === "detach") {
                return { kind: "value", value: { startedConversationId: childId, awaiting: false } };
            }
            const wakeAt = chaseWakeAt(awaitMode);
            return {
                kind: "pending",
                waitingFor: "assistant",
                ...(wakeAt ? { wakeAt } : {}),
                note: `awaiting conversation ${childId}`,
            };
        },
        /**
         * The child Conversation is born under the caller's own idempotency key, so "did this call
         * land?" is a question the store can answer — and this was the one mutating Operation that
         * never asked it. Without this, an interrupted call escalated to the User about work that
         * had demonstrably happened.
         */
        async reconcile(args, context): Promise<OperationOutcome | undefined> {
            const child = await things.findByIdempotencyKey<Conversation>(
                SPECS.Conversation_DM,
                context.idempotencyKey,
            );
            if (!child) {
                return {
                    kind: "error",
                    message:
                        "This call was interrupted before the other Assistant was started, so it did not take effect. Ask again if you still need them.",
                };
            }
            const awaitMode = String(args["awaitMode"] ?? "wait");
            if (awaitMode === "detach") {
                // A detached caller was never waiting, so it must not be suspended now.
                return { kind: "value", value: { startedConversationId: child.thingId, awaiting: false } };
            }
            if (child.data.resultDeliveredAt) {
                // The answer already reached the transcript; suspending again would wait for a
                // delivery that has been made and will not be made twice.
                return {
                    kind: "value",
                    value: { startedConversationId: child.thingId, awaiting: false, delivered: true },
                };
            }
            // Still owed an answer. `wakeAt` is re-derived, or recovery would silently downgrade a
            // chased call to a plain wait.
            const wakeAt = chaseWakeAt(awaitMode);
            return {
                kind: "pending",
                waitingFor: "assistant",
                ...(wakeAt ? { wakeAt } : {}),
                note: `awaiting conversation ${child.thingId}`,
            };
        },
    };

    const listAccounts: OperationImplementation = {
        name: "bookkeeping.listAccounts",
        mutating: false,
        // Reads nothing from its context — it takes no arguments at all — so the Dashboard's Accounts
        // Tile can call it with no Conversation behind it (ADR-0023).
        clientReadable: true,
        seed: {
            name: "List accounts",
            system: "Bookkeeping",
            kind: "connector",
            description:
                "List the chart of accounts. Always look here before booking — account names must match " +
                "exactly, and you may not invent one. Pass `type` to see only one kind: 'asset' is the " +
                "money the household holds, 'expense' and 'revenue' are the other side of a booking, " +
                "and 'liabilities' — plural — covers payables and receivables.",
            parameters: {
                type: "object",
                properties: {
                    type: str(
                        "Optional: only accounts of this Firefly type. " +
                            "asset | expense | revenue | liabilities.",
                    ),
                },
            },
        },
        async execute(args): Promise<OperationOutcome> {
            const accounts = await firefly.listAccounts(true);
            // Filtered here rather than in the Connector's request, deliberately: the Connector caches
            // the whole chart of accounts and `resolveAccountId` reads that same cache, so a
            // type-narrowed fetch would either poison it or need a second one. The list is a
            // household's, not an enterprise's.
            //
            // Compared case-insensitively because Firefly's *read* API answers `liabilities` where its
            // *write* API accepts `liability` — the exact mismatch that made `listOpenItems` report
            // nothing while thousands were owed (BUG-02). A caller who says either gets what they meant.
            const wanted = String(args["type"] ?? "").trim().toLowerCase();
            const matches = (accountType: string) =>
                wanted === "" ||
                accountType.toLowerCase() === wanted ||
                // "liability" and "liabilities" are one kind under two spellings, and no caller
                // should have to know which side of Firefly's API they are talking to.
                (accountType.toLowerCase().startsWith("liabilit") && wanted.startsWith("liabilit"));

            return {
                kind: "value",
                value: accounts
                    .filter((account) => matches(account.type))
                    .map((account) => ({
                        name: account.name,
                        type: account.type,
                        balance: account.currentBalance,
                        // The connector has always read this and this projection has always dropped
                        // it. A balance without its currency is a number, not an amount — the Accounts
                        // Tile cannot format one and a model reasoning about two accounts cannot
                        // compare them.
                        currency: account.currencyCode,
                    })),
            };
        },
    };

    const postTransaction: OperationImplementation = {
        name: "bookkeeping.postTransaction",
        mutating: true,
        describeCall: describePosting,
        seed: {
            name: "Book a transaction",
            system: "Bookkeeping",
            kind: "connector",
            description:
                "Book a balanced transaction into the books. Account names must already exist — call " +
                "bookkeeping.listAccounts first. Safe to retry: booking the same thing twice is a no-op. " +
                "The User must approve the exact posting before it happens: the first call is refused " +
                "and asks them, and you are resumed to make the same call again once they have said yes.",
            // The one Operation in the system that moves a number in someone's books, and therefore
            // the one the README's "nothing is booked without an answer" is about. It is a **seed**:
            // the Operation Thing carries the authoritative value, and the User owns it in both
            // directions (ADR-0018, as amended).
            //
            // `bookkeeping.createAccount` deliberately does NOT carry it: it is granted to no
            // Assistant (see ACCOUNTANT's grants), so the flag would only add a path nothing
            // exercises.
            requiresApproval: true,
            parameters: {
                type: "object",
                properties: {
                    groupTitle: str("A short title for the whole transaction."),
                    thingId: str(
                        "The ThingID of the Invoice this books. Always supply it: it links the journal " +
                            "back to the Invoice, and it is the only way a repeat of this posting can be " +
                            "recognised — the idempotency key differs between Turns, so it cannot.",
                    ),
                    splits: {
                        type: "array",
                        description: "The postings. Usually one.",
                        items: {
                            type: "object",
                            properties: {
                                type: { type: "string", enum: ["withdrawal", "deposit", "transfer"] },
                                date: str("yyyy-mm-dd"),
                                amount: str("A positive decimal, e.g. \"184.30\"."),
                                description: str("What this posting is."),
                                sourceAccount: str("Exact name of the account money leaves."),
                                destinationAccount: str("Exact name of the account money arrives at."),
                                currencyCode: str(
                                    "The amount's currency, if it is not the account's own. A posting in " +
                                        "another currency is refused rather than booked at the same " +
                                        "number — convert it first, or ask the User.",
                                ),
                                budgetName: str("Optional budget to charge."),
                                categoryName: str("Optional category."),
                                notes: str("Optional notes."),
                            },
                            required: [
                                "type",
                                "date",
                                "amount",
                                "description",
                                "sourceAccount",
                                "destinationAccount",
                            ],
                        },
                    },
                },
                required: ["splits"],
            },
        },
        async execute(args, context): Promise<OperationOutcome> {
            const splits = (args["splits"] ?? []) as PostingSplit[];
            if (!Array.isArray(splits) || splits.length === 0) {
                return { kind: "error", message: "postTransaction needs at least one split." };
            }
            let result;
            try {
                result = await firefly.postTransaction({
                    groupTitle: args["groupTitle"] ? String(args["groupTitle"]) : undefined,
                    externalId: context.idempotencyKey,
                    thingId: args["thingId"] ? String(args["thingId"]) : undefined,
                    splits,
                });
            } catch (error) {
                if (!(error instanceof FireflyError)) throw error;
                // Translated here rather than left to the generic error path, because only the
                // caller knows which account *name* the model supplied for the id Firefly is
                // complaining about. The raw 422 stays in the log for whoever has to debug Firefly.
                log.error("firefly refused a posting", {
                    status: error.status,
                    message: error.message,
                    details: error.details,
                });
                return { kind: "error", message: describeRejection(error, splits) };
            }
            return {
                kind: "value",
                value: {
                    transactionId: result.id,
                    alreadyExisted: result.alreadyExisted,
                },
            };
        },
        async reconcile(_args, context): Promise<OperationOutcome | undefined> {
            // The one that would cost real money. Firefly carries our key in `external_id`, so
            // this is a question we can actually answer rather than a guess.
            const landed = await firefly.findByExternalId(context.idempotencyKey);
            return landed
                ? { kind: "value", value: { transactionId: landed.id, alreadyExisted: true } }
                : {
                      kind: "error",
                      message:
                          "This booking was interrupted before it reached the books, so nothing was posted. Book it again if it is still right.",
                  };
        },
    };

    const listTransactions: OperationImplementation = {
        name: "bookkeeping.listTransactions",
        mutating: false,
        /** Reads only its `args`; the Transactions Tile supplies a date window (ADR-0023). */
        clientReadable: true,
        seed: {
            name: "List transactions",
            system: "Bookkeeping",
            kind: "connector",
            description:
                "The register: transactions in a date range, optionally for one account. Use this to " +
                "check what has already been booked before booking something again.",
            parameters: {
                type: "object",
                properties: {
                    start: str("First day to include, yyyy-mm-dd."),
                    end: str("Last day to include, yyyy-mm-dd. Must be after start."),
                    account: str("Optional: restrict to one account, by its exact name."),
                    limit: num(`Maximum transactions (default 25, at most ${TRANSACTIONS_LIMIT_MAX}).`),
                },
                required: ["start", "end"],
            },
        },
        async execute(args): Promise<OperationOutcome> {
            // Both callers are strangers in different ways: an LLM writes a date from a sentence, and
            // — since this Operation became `clientReadable` (ADR-0023) — a browser writes one from a
            // form. The Connector now encodes what it is given, so a stray `&` can no longer steer the
            // outbound request; refusing it here as well means the caller is told *why* rather than
            // quietly receiving a window it did not ask for.
            const start = String(args["start"] ?? "");
            const end = String(args["end"] ?? "");
            for (const [field, value] of [["start", start], ["end", end]] as const) {
                if (!ISO_DATE.test(value)) {
                    return {
                        kind: "error",
                        message:
                            `\`${field}\` must be a calendar date written yyyy-mm-dd, e.g. 2026-01-31 — ` +
                            `got "${value}". Give the first and last day of the window explicitly.`,
                    };
                }
            }

            const groups = await firefly.listTransactions({
                start,
                end,
                accountName: args["account"] ? String(args["account"]) : undefined,
                // Clamped, because the response is buffered into the process that runs the scan loop:
                // a browser asking for a million rows would be asking the Runtime to stop watching.
                limit: Math.min(
                    TRANSACTIONS_LIMIT_MAX,
                    Math.max(1, Number(args["limit"] ?? 25) || 25),
                ),
            });
            // Projected rather than passed through: a Firefly group carries several dozen fields per
            // split, and a register the model cannot read in one glance is a register it will not use.
            return { kind: "value", value: groups.flatMap(projectTransactionGroup) };
        },
    };

    const getBalance: OperationImplementation = {
        name: "bookkeeping.getBalance",
        mutating: false,
        /** Reads only its `args`. Marked for symmetry; the Dashboard uses listAccounts instead. */
        clientReadable: true,
        seed: {
            name: "Account balance",
            system: "Bookkeeping",
            kind: "connector",
            description: "The current balance of one account.",
            parameters: {
                type: "object",
                properties: { account: str("Exact account name.") },
                required: ["account"],
            },
        },
        async execute(args): Promise<OperationOutcome> {
            return { kind: "value", value: await firefly.getBalance(String(args["account"] ?? "")) };
        },
    };

    const listOpenItems: OperationImplementation = {
        name: "bookkeeping.listOpenItems",
        mutating: false,
        seed: {
            name: "List open items",
            system: "Bookkeeping",
            kind: "connector",
            description:
                "Unpaid invoices and unclaimed reimbursements — the non-zero balances on payable and " +
                "receivable accounts.",
            parameters: { type: "object", properties: {} },
        },
        async execute(): Promise<OperationOutcome> {
            return { kind: "value", value: await firefly.listOpenItems() };
        },
    };

    const getBudgetReport: OperationImplementation = {
        name: "bookkeeping.getBudgetReport",
        mutating: false,
        seed: {
            name: "Budget report",
            system: "Bookkeeping",
            kind: "connector",
            description:
                "Each budget's target and what has been spent against it, for a period. Defaults to the " +
                "current calendar month. A budget with no target set for the period reports no limit, " +
                "which is not the same as a target of zero.",
            parameters: {
                type: "object",
                properties: {
                    start: str(
                        "First day of the period, yyyy-mm-dd. Defaults to the 1st of this month.",
                    ),
                    end: str("Last day of the period, yyyy-mm-dd. Defaults to the end of this month."),
                },
            },
        },
        async execute(args): Promise<OperationOutcome> {
            // A period is required by Firefly, not optional: without one it reports `spent: null` for
            // every budget, which reads as "nothing spent". ACCOUNTING.md always specified
            // `getBudgetReport(period)`; the parameter simply was not there.
            const month = currentMonth();
            const start = args["start"] ? String(args["start"]) : month.start;
            const end = args["end"] ? String(args["end"]) : month.end;
            return { kind: "value", value: await firefly.listBudgets({ start, end }) };
        },
    };

    const createAccount: OperationImplementation = {
        name: "bookkeeping.createAccount",
        mutating: true,
        seed: {
            name: "Create an account",
            system: "Bookkeeping",
            kind: "connector",
            description: "Add an account to the chart of accounts.",
            parameters: {
                type: "object",
                properties: {
                    name: str("The account name."),
                    type: str("asset | expense | revenue | liability."),
                    currencyCode: str("Default EUR."),
                },
                required: ["name", "type"],
            },
        },
        async execute(args): Promise<OperationOutcome> {
            // Search-then-create, so a repeated Turn cannot produce two accounts with one name —
            // the silent chart corruption this connector exists to prevent.
            const name = String(args["name"] ?? "");
            const accounts = await firefly.listAccounts(true);
            const existing = accounts.find(
                (account) => account.name.toLowerCase() === name.trim().toLowerCase(),
            );
            if (existing) return { kind: "value", value: { ...existing, alreadyExisted: true } };
            const created = await firefly.createAccount({
                name,
                type: String(args["type"] ?? "expense"),
                currencyCode: args["currencyCode"] ? String(args["currencyCode"]) : undefined,
            });
            return { kind: "value", value: created };
        },
        async reconcile(args): Promise<OperationOutcome> {
            const name = String(args["name"] ?? "");
            const accounts = await firefly.listAccounts(true);
            const existing = accounts.find(
                (account) => account.name.toLowerCase() === name.trim().toLowerCase(),
            );
            return existing
                ? { kind: "value", value: { ...existing, alreadyExisted: true } }
                : { kind: "error", message: `This call was interrupted; no account named "${name}" exists.` };
        },
    };

    /**
     * Manual Connectors.
     *
     * There is nothing special about them: the Operation cannot complete now, so it raises an
     * Open Question of kind `perform` and returns `pending`. The Assistant cannot tell whether a
     * machine or a human will answer, which is exactly what CONTEXT.md claims — and it is why
     * automating one of these later touches only the Connector.
     */
    function manualConnector(input: {
        name: string;
        label: string;
        system: string;
        description: string;
        properties: Record<string, unknown>;
        required: string[];
        renderPrompt(args: Record<string, unknown>): string;
    }): OperationImplementation {
        return {
            name: input.name,
            mutating: true,
            seed: {
                name: input.label,
                system: input.system,
                kind: "manual-connector",
                // The sentence is appended here rather than written into each description, because
                // it is a property of *being* a Manual Connector rather than of any one of them.
                description: `${input.description} This is performed by the User by hand, so it may take a while.`,
                parameters: {
                    type: "object",
                    properties: input.properties,
                    required: input.required,
                },
            },
            async execute(args, context): Promise<OperationOutcome> {
                const questionId = await deps.raiseQuestion({
                    context,
                    kind: "perform",
                    prompt: input.renderPrompt(args),
                    subjectThingId: context.conversation.data.subjectThingId,
                });
                return { kind: "pending", waitingFor: "tool", questionId };
            },
            async reconcile(_args, context): Promise<OperationOutcome | undefined> {
                const existing = await things.findByIdempotencyKey<OpenQuestion>(
                    SPECS.OpenQuestion_DM,
                    context.idempotencyKey,
                );
                if (!existing) return undefined;
                // Same rule as the watcher's scan; see `askUser.reconcile` above.
                return isAnswered(existing.data)
                    ? { kind: "value", value: { done: true } }
                    : { kind: "pending", waitingFor: "tool", questionId: existing.thingId };
            },
        };
    }

    const requestText = manualConnector({
        name: "document.requestText",
        label: "Request a transcription",
        system: "UserInterface",
        description: "Ask for the text of a document that has not been transcribed yet.",
        properties: {
            thingId: str("The Document's ThingID."),
            why: str("Why you need it."),
        },
        required: ["thingId"],
        renderPrompt: (args) =>
            [
                `**Please transcribe a document.**`,
                ``,
                `Document: \`${String(args["thingId"] ?? "")}\``,
                args["why"] ? `\nWhy: ${String(args["why"])}` : "",
                ``,
                `Open the document, copy its text, and paste it below.`,
            ].join("\n"),
    });

    const emailSend = manualConnector({
        name: "email.send",
        label: "Send an email",
        system: "Email",
        description: "Send an email.",
        properties: {
            to: str("Recipient."),
            subject: str("Subject line."),
            body: str("The message, in markdown."),
        },
        required: ["to", "subject", "body"],
        renderPrompt: (args) =>
            [
                `**Please send this email.**`,
                ``,
                `To: ${String(args["to"] ?? "")}`,
                `Subject: ${String(args["subject"] ?? "")}`,
                ``,
                `---`,
                ``,
                String(args["body"] ?? ""),
                ``,
                `---`,
                ``,
                `When you have sent it, confirm below (and paste any reply you get).`,
            ].join("\n"),
    });

    const emailFetch = manualConnector({
        name: "email.fetch",
        label: "Check the post",
        system: "Email",
        description: "Ask for new mail matching a description.",
        properties: { matching: str("What to look for.") },
        required: ["matching"],
        renderPrompt: (args) =>
            [
                `**Please check the post.**`,
                ``,
                `Looking for: ${String(args["matching"] ?? "anything new")}`,
                ``,
                `Paste what you find below, or say "nothing".`,
            ].join("\n"),
    });

    const bankSendMoney = manualConnector({
        name: "bank.sendMoney",
        label: "Send money",
        system: "Bank",
        description: "Transfer money.",
        properties: {
            iban: str("Recipient IBAN."),
            amount: str("Amount, e.g. 184.30."),
            currency: str("Currency, default EUR."),
            reference: str("Payment reference."),
        },
        required: ["iban", "amount", "reference"],
        renderPrompt: (args) =>
            [
                `**Please make this payment.**`,
                ``,
                `| | |`,
                `|---|---|`,
                `| IBAN | \`${String(args["iban"] ?? "")}\` |`,
                `| Amount | ${String(args["amount"] ?? "")} ${String(args["currency"] ?? "EUR")} |`,
                `| Reference | ${String(args["reference"] ?? "")} |`,
                ``,
                `Confirm below once it has gone out, and paste the transaction reference if you have one.`,
            ].join("\n"),
    });

    /**
     * The two reading Operations, and what they share.
     *
     * Both are pointed at a Document, both write exactly one field, and both must refuse to write
     * it when it already says something. That refusal is the important half: `extractedText` may
     * hold a transcription a human typed — `document.requestText` is precisely that path — and a
     * reader that overwrote it would destroy work nobody can get back, silently, for a field it was
     * only ever asked to fill.
     */
    type DocumentToRead =
        | { refused: OperationOutcome }
        | { docRef: string; data: Record<string, unknown> };

    async function documentToRead(args: Record<string, unknown>): Promise<DocumentToRead> {
        const thingId = String(args["thingId"] ?? "").trim();
        if (!thingId) {
            return { refused: { kind: "error", message: "This needs the Document's thingId." } };
        }
        const docRef = `${SPECS.Document_DM.model}/${thingId}`;
        const document = await things.get<Record<string, unknown>>(DOCUMENT_WITH_ATTACHMENT, docRef);
        const existing = String(document.data["extractedText"] ?? "").trim();
        // `"true"` as well as `true`: a model that emits its booleans as strings would otherwise
        // have `replace` silently ignored, and be told the Document already has text when it has
        // just asked for that text to be replaced.
        const replace = args["replace"] === true || args["replace"] === "true";
        if (existing !== "" && !replace) {
            return { refused: { kind: "value", value: { skipped: "already-has-text" } } };
        }
        return { docRef, data: document.data };
    }

    /** Shared by both readers, so the sentence about a missing Content Store is written once. */
    async function attachmentBytes(
        data: Record<string, unknown>,
    ): Promise<{ refused: OperationOutcome } | { bytes: Buffer }> {
        const attachment = attachmentOf(data);
        if (!attachment?.attachment_id) {
            return { refused: { kind: "value", value: { reason: "no-attachment" } } };
        }
        if (!deps.content) {
            // A misconfigured Runtime, not a Document behaving unusually — so this one really is an
            // error. Nothing the model does next can make it right, and it should say so plainly.
            return {
                refused: {
                    kind: "error",
                    message:
                        "This Runtime has no Content Store client, so no attachment can be read. " +
                        "That is a deployment fault; tell the User rather than trying again.",
                },
            };
        }
        return { bytes: await deps.content.download(attachment.attachment_id) };
    }

    /** "Has the text landed?", answered from the Document. Both readers reconcile the same way. */
    async function textOnDocument(args: Record<string, unknown>): Promise<number | undefined> {
        const thingId = String(args["thingId"] ?? "").trim();
        if (!thingId) return undefined;
        const document = await things.get<DocumentThing>(
            SPECS.Document_DM,
            `${SPECS.Document_DM.model}/${thingId}`,
        );
        return String(document.data.extractedText ?? "").trim().length;
    }

    const replaceParameter = {
        type: "boolean",
        description:
            "Overwrite text the Document already has. Leave it out unless the User asked for it: " +
            "the existing text may be a person's own transcription.",
    };

    const extractText: OperationImplementation = {
        name: "document.extractText",
        mutating: true,
        // Never `clientReadable`: it writes.
        seed: {
            name: "Read a document's text layer",
            system: "ThingStore",
            kind: "connector",
            description:
                "Read the text layer of a Document's attachment and store it as the Document's text. " +
                "Free, exact and deterministic — try this before anything that costs money. Whatever " +
                "text it finds is stored, however little: when there is very little it says so with " +
                "'sparse': true and tells you how many characters, because a short text layer is " +
                "either a short document — a one-line reminder, a parking receipt, a dentist's " +
                "invoice — or a scanner's watermark on an unreadable scan, and only you can tell " +
                "which by reading it. It reports 'no-text-layer' only when the attachment carries no " +
                "text at all, which is an ordinary answer and not a failure: read it with " +
                "document.readScan, or ask a human with document.requestText. Text the Document " +
                "already has is never overwritten.",
            parameters: {
                type: "object",
                properties: {
                    thingId: str("The Document's ThingID."),
                    replace: replaceParameter,
                },
                required: ["thingId"],
            },
        },
        async execute(args): Promise<OperationOutcome> {
            const subject = await documentToRead(args);
            if ("refused" in subject) return subject.refused;

            const attachment = await attachmentBytes(subject.data);
            if ("refused" in attachment) return attachment.refused;

            const layer = await readTextLayer(attachment.bytes);
            if (layer.kind !== "text") {
                // A **value** either way, deliberately. `no-text-layer` is the likeliest outcome on
                // a scanned invoice and it is what tells the caller to try the next rung; an `error`
                // would put a red entry in the transcript for a document behaving exactly as
                // expected, and teach the model that something went wrong when nothing did.
                return layer.kind === "no-text-layer"
                    ? { kind: "value", value: { reason: "no-text-layer", pages: layer.pages } }
                    : { kind: "value", value: { reason: "not-a-pdf" } };
            }
            // Sparse text is stored too. Eighty-four characters may be a scanner's watermark or may
            // be the whole of a short invoice, and this Operation is in no position to tell: it can
            // see the length and not the meaning. Storing it and *saying it is short* leaves the
            // judgement with the Receptionist, which is where this system puts judgement — and it
            // costs nothing to be wrong, because the next rung is still there. Throwing it away
            // instead is what used to send a perfectly readable invoice to a paid vision model.
            //
            // `extractedText` and nothing else. `update` merges onto the stored document, so the
            // attachment, the classification and everything else survive untouched.
            await things.update(SPECS.Document_DM, subject.docRef, { extractedText: layer.text });
            log.info("read a document's text layer", {
                thingId: String(args["thingId"] ?? ""),
                pages: layer.pages,
                characters: layer.text.length,
                sparse: layer.sparse,
            });
            return {
                kind: "value",
                value: {
                    pages: layer.pages,
                    characters: layer.text.length,
                    ...(layer.sparse
                        ? {
                              sparse: true,
                              note:
                                  `Only ${layer.text.length} characters, which is little enough to be a ` +
                                  "scanner artefact and equally to be a short document — a one-line " +
                                  "reminder, a receipt, a small invoice. The text is stored on the " +
                                  "Document: read it and decide. If it turns out to be noise rather " +
                                  "than the document, document.readScan with replace: true is the " +
                                  "next rung.",
                          }
                        : {}),
                },
            };
        },
        async reconcile(args): Promise<OperationOutcome | undefined> {
            // Answerable, and worth answering even though repeating this is harmless: it is
            // deterministic over unchanged bytes and it refuses a non-empty field, so the worst a
            // re-run can do is cost a Turn.
            const characters = await textOnDocument(args);
            if (characters === undefined) return undefined;
            return characters > 0
                ? { kind: "value", value: { characters, alreadyExtracted: true } }
                : {
                      kind: "error",
                      message:
                          "This extraction was interrupted and the Document still has no text. Call it again — repeating it is safe.",
                  };
        },
    };

    const readScan: OperationImplementation = {
        name: "document.readScan",
        mutating: true,
        // No `requiresApproval` in the seed, deliberately: an approval per scanned invoice is two
        // questions per piece of post, and ADR-0018 makes adding one the User's to decide on the
        // Operation Thing.
        seed: {
            name: "Read a scanned document",
            system: "ThingStore",
            kind: "connector",
            description:
                "Read a scanned attachment with a vision model and store what it says as the " +
                "Document's text. This costs money per page, so call it only after " +
                "document.extractText has reported 'no-text-layer', or has reported 'sparse' text " +
                "that you have read and judged to be a scanner's noise rather than the document " +
                "(in which case pass replace: true, since that noise is now the Document's text) — " +
                "and only when the document is worth reading: a bill, a letter or a quote is; an " +
                "advertising leaflet is not. It " +
                "reports 'unavailable' when no vision model is configured, and refuses anything over " +
                "its page or size cap rather than reading part of it. Text the Document already has " +
                "is never overwritten.",
            parameters: {
                type: "object",
                properties: {
                    thingId: str("The Document's ThingID."),
                    replace: replaceParameter,
                },
                required: ["thingId"],
            },
        },
        async execute(args): Promise<OperationOutcome> {
            // First, because it is free and because it is the shipped default: with no `vision`
            // profile there is nothing to send a PDF to, and downloading one to discover that would
            // be work done for an answer already known.
            if (!vision.available) return { kind: "value", value: { reason: "unavailable" } };

            const subject = await documentToRead(args);
            if ("refused" in subject) return subject.refused;

            const attachment = await attachmentBytes(subject.data);
            if ("refused" in attachment) return attachment.refused;

            const bytes = attachment.bytes;
            if (bytes.length > limits.visionMaxBytes) {
                return { kind: "value", value: { reason: "too-large", bytes: bytes.length } };
            }
            // The page count comes from the free reader, which returns it even when it finds no text
            // — so nothing is ever sent uncapped. A file `pdfjs` cannot open has no page count, and
            // a document whose length is unknown is exactly what the cap exists to refuse.
            const layer = await readTextLayer(bytes);
            if (layer.kind === "not-a-pdf") return { kind: "value", value: { reason: "not-a-pdf" } };
            const pages = layer.pages ?? 0;
            if (pages > limits.visionMaxPages) {
                // A reason, never a truncated read: a partial invoice is worse than no invoice,
                // because it looks complete.
                return { kind: "value", value: { reason: "too-many-pages", pages } };
            }

            const read = await vision.read(bytes, pages);
            await things.update(SPECS.Document_DM, subject.docRef, { extractedText: read.text });
            log.info("read a scanned document with a vision model", {
                thingId: String(args["thingId"] ?? ""),
                reader: vision.name,
                pages,
                characters: read.text.length,
            });
            return {
                kind: "value",
                value: {
                    pages,
                    characters: read.text.length,
                    // In the outcome because the Loop Driver adds it to what the Turn records. Left
                    // out, this spend would be invisible — and it would grow with ordinary
                    // successful use.
                    ...(read.usage ? { usage: read.usage } : {}),
                },
            };
        },
        async reconcile(args): Promise<OperationOutcome | undefined> {
            // The one reader where repeating costs money, so the interrupted case says what is true
            // rather than inviting a retry.
            const characters = await textOnDocument(args);
            if (characters === undefined) return undefined;
            return characters > 0
                ? { kind: "value", value: { characters, alreadyRead: true } }
                : {
                      kind: "error",
                      message:
                          "This scan was interrupted and nothing was written to the Document. Reading it again costs money; do it only if the document is still worth it.",
                  };
        },
    };

    /**
     * The letterbox, in the catalogue.
     *
     * It is here so the User can read it, describe it and switch it off — not because anything calls
     * it through a Turn. **No Assistant is granted it**: an Assistant that could pull the household's
     * post into a Conversation on a whim is not something this design wants, and the ingest calls
     * its own code directly the way the scan loop calls what it needs. `execute` therefore says so
     * rather than triggering a poll, which would be a second way into the letterbox and would put a
     * fabricated conversation id in front of the mail Connector.
     */
    const emailReceive: OperationImplementation = {
        name: "email.receive",
        mutating: true,
        seed: {
            name: "Receive email",
            system: "Email",
            kind: "connector",
            description:
                "Take delivery of forwarded mail and turn each message into a Document. The Runtime " +
                "runs this on its own schedule; it is in the catalogue so it can be described and " +
                "switched off, and no Assistant calls it.",
            parameters: {
                type: "object",
                properties: {
                    externalRef: str(
                        "The message's Message-ID, which is how a Document already ingested from it " +
                            "is recognised.",
                    ),
                },
                required: ["externalRef"],
            },
        },
        async execute(): Promise<OperationOutcome> {
            return {
                kind: "value",
                value: {
                    reason: "driven-by-the-runtime",
                    note:
                        "Mail is collected by the Runtime's own scan loop, which creates a Document " +
                        "per message before any Assistant is woken. There is nothing for a Turn to " +
                        "call here. Switching this Operation off stops the letterbox.",
                },
            };
        },
        async reconcile(args): Promise<OperationOutcome | undefined> {
            // Answerable because `ExternalRef` is a real key: the store knows whether a message has
            // already become a Document, so recovery never has to guess.
            const externalRef = String(args["externalRef"] ?? "").trim();
            if (!externalRef) return undefined;
            const [existing] = await things.search<DocumentThing>(
                SPECS.Document_DM,
                eq(fieldPath(SPECS.Document_DM, "externalRef"), externalRef),
                1,
            );
            return existing
                ? { kind: "value", value: { thingId: existing.thingId, alreadyReceived: true } }
                : {
                      kind: "error",
                      message: `No Document carries the external reference "${externalRef}", so nothing was ingested under it.`,
                  };
        },
    };

    return [
        thingstoreCreate,
        thingstoreGet,
        thingstoreUpdate,
        thingstoreSearch,
        askUser,
        assistantCall,
        listAccounts,
        postTransaction,
        listTransactions,
        getBalance,
        listOpenItems,
        getBudgetReport,
        createAccount,
        requestText,
        emailSend,
        emailFetch,
        bankSendMoney,
        extractText,
        readScan,
        emailReceive,
    ];
}

export { isTriggerEligible };
export type { OpenQuestion, ThingModel };
