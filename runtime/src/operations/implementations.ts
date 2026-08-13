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
import {
    isTriggerEligible,
    type Assistant,
    type Conversation,
    type OpenQuestion,
    type ThingModel,
} from "../domain/types.js";

export interface OperationDeps {
    things: ThingRepository;
    firefly: FireflyConnector;
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

export function buildOperations(deps: OperationDeps): OperationImplementation[] {
    const { things, firefly } = deps;

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
            const merged: Record<string, unknown> = { ...fields };
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
            const limit = Number(args["limit"] ?? 25) || 25;
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
            const kind = String(args["kind"] ?? "free-text") as "free-text" | "confirm" | "choice";
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
        seed: {
            name: "List accounts",
            system: "Bookkeeping",
            kind: "connector",
            description:
                "List the chart of accounts. Always look here before booking — account names must match " +
                "exactly, and you may not invent one.",
            parameters: { type: "object", properties: {} },
        },
        async execute(): Promise<OperationOutcome> {
            const accounts = await firefly.listAccounts(true);
            return {
                kind: "value",
                value: accounts.map((account) => ({
                    name: account.name,
                    type: account.type,
                    balance: account.currentBalance,
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
                    limit: num("Maximum transactions (default 25)."),
                },
                required: ["start", "end"],
            },
        },
        async execute(args): Promise<OperationOutcome> {
            const groups = await firefly.listTransactions({
                start: String(args["start"] ?? ""),
                end: String(args["end"] ?? ""),
                accountName: args["account"] ? String(args["account"]) : undefined,
                limit: Number(args["limit"] ?? 25) || 25,
            });
            // Projected rather than passed through: a Firefly group carries several dozen fields per
            // split, and a register the model cannot read in one glance is a register it will not use.
            return { kind: "value", value: groups.flatMap(projectTransactionGroup) };
        },
    };

    const getBalance: OperationImplementation = {
        name: "bookkeeping.getBalance",
        mutating: false,
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
    ];
}

export { isTriggerEligible };
export type { OpenQuestion, ThingModel };
