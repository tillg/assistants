/**
 * The typed Thing repository.
 *
 * An A12 document is a nested object keyed by the *names* in the model — the root group, then
 * groups, then fields:
 *
 *     { "Party": { "Name": "Dr Meyer", "Notes": "…" } }
 *
 * Everything below is the translation between that shape and the plain TypeScript types in
 * `domain/types.ts`, plus the query paths (`/Party/Name`) the watcher filters on.
 */

import { log } from "../log.js";
import {
    A12Client,
    type A12Document,
    type Constraint,
    type QueryEntry,
    type QuerySpec,
} from "./client.js";
import {
    type Assistant,
    type Conversation,
    type DocumentThing,
    type Invoice,
    type OpenQuestion,
    type Party,
    type ProcessThing,
    type RuntimeState,
    type Stored,
    type ThingModel,
    thingIdOf,
} from "../domain/types.js";

/** How one Model maps onto the A12 document shape. */
export interface ModelSpec {
    model: ThingModel;
    /** The root group's `name` in the document model. */
    root: string;
    /** TypeScript property → A12 field name, for scalar fields. */
    fields: Record<string, string>;
    /** TypeScript property → { group name, inner field map } for repeating groups. */
    groups?: Record<string, { name: string; fields: Record<string, string> }>;
}

/**
 * The store's ceiling on an `exact_match` value, measured. Shorter than the 200-character fields it
 * searches, so a storable idempotency key can be an unsearchable one.
 */
const EXACT_MATCH_MAX_LENGTH = 100;

const MACHINE_FIELDS = {
    idempotencyKey: "IdempotencyKey",
    createdByConversationId: "CreatedByConversationId",
    createdAt: "CreatedAt",
    updatedAt: "UpdatedAt",
} as const;

export const SPECS = {
    Party_DM: {
        model: "Party_DM",
        root: "Party",
        fields: {
            kind: "Kind",
            role: "Role",
            name: "Name",
            legalName: "LegalName",
            email: "Email",
            phone: "Phone",
            street: "Street",
            postcode: "Postcode",
            city: "City",
            country: "Country",
            iban: "Iban",
            notes: "Notes",
            ...MACHINE_FIELDS,
        },
    },
    Document_DM: {
        model: "Document_DM",
        root: "Document",
        fields: {
            title: "Title",
            receivedAt: "ReceivedAt",
            source: "Source",
            mediaType: "MediaType",
            externalRef: "ExternalRef",
            extractedText: "ExtractedText",
            classification: "Classification",
            classifiedThingId: "ClassifiedThingId",
            classifiedModel: "ClassifiedModel",
            classificationNote: "ClassificationNote",
            ...MACHINE_FIELDS,
        },
    },
    Invoice_DM: {
        model: "Invoice_DM",
        root: "Invoice",
        fields: {
            invoiceNumber: "InvoiceNumber",
            issuedByPartyThingId: "IssuedByPartyThingId",
            issuerName: "IssuerName",
            issueDate: "IssueDate",
            dueDate: "DueDate",
            serviceDate: "ServiceDate",
            amountGross: "AmountGross",
            amountNet: "AmountNet",
            currency: "Currency",
            subject: "Subject",
            recipientName: "RecipientName",
            documentThingId: "DocumentThingId",
            processThingId: "ProcessThingId",
            notes: "Notes",
            ...MACHINE_FIELDS,
        },
    },
    Process_DM: {
        model: "Process_DM",
        root: "Process",
        fields: {
            title: "Title",
            kind: "Kind",
            status: "Status",
            summary: "Summary",
            ...MACHINE_FIELDS,
        },
        groups: {
            steps: {
                name: "Steps",
                fields: { seq: "Seq", title: "Title", state: "State", note: "Note", doneAt: "DoneAt" },
            },
            related: {
                name: "Related",
                fields: { thingId: "ThingId", model: "Model", note: "Note" },
            },
        },
    },
    Assistant_DM: {
        model: "Assistant_DM",
        root: "Assistant",
        fields: {
            key: "Key",
            name: "Name",
            description: "Description",
            systemPrompt: "SystemPrompt",
            llmModel: "LlmModel",
            enabled: "Enabled",
            maxTurns: "MaxTurns",
            ...MACHINE_FIELDS,
        },
        groups: {
            skills: { name: "Skills", fields: { name: "SkillName", instructions: "SkillInstructions" } },
            triggers: {
                name: "Triggers",
                fields: { kind: "TriggerKind", modelFilter: "TriggerModelFilter", cron: "TriggerCron" },
            },
            tools: { name: "Tools", fields: { operation: "ToolOperation" } },
        },
    },
    Conversation_DM: {
        model: "Conversation_DM",
        root: "Conversation",
        fields: {
            assistantKey: "AssistantKey",
            title: "Title",
            subjectThingId: "SubjectThingId",
            subjectModel: "SubjectModel",
            status: "Status",
            waitingFor: "WaitingFor",
            finishReason: "FinishReason",
            turnCount: "TurnCount",
            maxTurns: "MaxTurns",
            wakeAt: "WakeAt",
            leaseUntil: "LeaseUntil",
            parentConversationId: "ParentConversationId",
            currentQuestionId: "CurrentQuestionId",
            resultDeliveredAt: "ResultDeliveredAt",
            escalationCount: "EscalationCount",
            result: "Result",
            lastError: "LastError",
            ...MACHINE_FIELDS,
        },
        groups: {
            entries: {
                name: "Entries",
                fields: {
                    seq: "Seq",
                    at: "At",
                    role: "Role",
                    kind: "Kind",
                    text: "Text",
                    toolName: "ToolName",
                    toolArgs: "ToolArgs",
                    toolResult: "ToolResult",
                    idempotencyKey: "IdempotencyKey",
                },
            },
        },
    },
    OpenQuestion_DM: {
        model: "OpenQuestion_DM",
        root: "OpenQuestion",
        fields: {
            conversationId: "ConversationId",
            assistantKey: "AssistantKey",
            seq: "Seq",
            kind: "Kind",
            subjectThingId: "SubjectThingId",
            prompt: "Prompt",
            text: "Text",
            choice: "Choice",
            confirmed: "Confirmed",
            answeredAt: "AnsweredAt",
            ...MACHINE_FIELDS,
        },
        groups: {
            options: { name: "Options", fields: { value: "OptionValue", label: "OptionLabel" } },
        },
    },
    RuntimeState_DM: {
        model: "RuntimeState_DM",
        root: "RuntimeState",
        fields: {
            singletonKey: "SingletonKey",
            watermark: "Watermark",
            paused: "Paused",
            birthsThisHour: "BirthsThisHour",
            birthWindowStartedAt: "BirthWindowStartedAt",
            heartbeatAt: "HeartbeatAt",
            lastError: "LastError",
            ...MACHINE_FIELDS,
        },
        groups: {
            watermarkDocRefs: { name: "WatermarkDocRefs", fields: { docRef: "DocRef" } },
        },
    },
} as const satisfies Record<ThingModel, ModelSpec>;

/** The query path for a scalar field: `/Party/Name`. */
export function path(spec: ModelSpec, property: string): string {
    const field = spec.fields[property];
    if (!field) throw new Error(`${spec.model} has no scalar field '${property}'`);
    return `/${spec.root}/${field}`;
}

export function toDocument(spec: ModelSpec, data: Record<string, unknown>): A12Document {
    const body: Record<string, unknown> = {};
    for (const [property, field] of Object.entries(spec.fields)) {
        const value = data[property];
        if (value === undefined) continue;
        body[field] = value;
    }
    for (const [property, group] of Object.entries(spec.groups ?? {})) {
        const rows = data[property];
        if (!Array.isArray(rows)) continue;
        body[group.name] = rows.map((row: Record<string, unknown>) => {
            const out: Record<string, unknown> = {};
            for (const [rowProperty, rowField] of Object.entries(group.fields)) {
                const value = row[rowProperty];
                if (value !== undefined) out[rowField] = value;
            }
            return out;
        });
    }
    return { [spec.root]: body };
}

export function fromDocument(spec: ModelSpec, document: A12Document): Record<string, unknown> {
    const body = (document[spec.root] ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [property, field] of Object.entries(spec.fields)) {
        if (body[field] !== undefined) out[property] = body[field];
    }
    for (const [property, group] of Object.entries(spec.groups ?? {})) {
        const rows = body[group.name];
        if (!Array.isArray(rows)) continue;
        out[property] = rows.map((row: Record<string, unknown>) => {
            const item: Record<string, unknown> = {};
            for (const [rowProperty, rowField] of Object.entries(group.fields)) {
                if (row[rowField] !== undefined) item[rowProperty] = row[rowField];
            }
            return item;
        });
    }
    return out;
}

export const eq = (field: string, value: string | number | boolean): Constraint => ({
    operator: "exact_match",
    field,
    value: String(value),
});

/**
 * Order by our own `createdAt`.
 *
 * All three of `direction`, `nullHandling` and `ignoreCase` are required — the server rejects a
 * null in any of them, and the field names are its own rather than the obvious ones (`direction`,
 * not `order`). Verified against the live store on all eight Models, including alongside
 * `exact_match` and `date_range`, and on a second page.
 */
export const byCreatedAt = (spec: ModelSpec, direction: "ASC" | "DESC"): QuerySpec["sort"] => [
    {
        field: path(spec, "createdAt"),
        direction,
        nullHandling: "NULLS_LAST",
        ignoreCase: false,
    },
];

export const unset = (field: string): Constraint => ({ operator: "undefined_match", field });

/**
 * NOTE the singular `operand`. `and` and `or` take `operands` (plural, an array); `not` takes
 * `operand` (singular). Getting it wrong is rejected with "Please provide operand for not
 * operator", which the watcher only discovers at runtime.
 */
export const not = (operand: Constraint): Constraint => ({ operator: "not", operand });

export const and = (...operands: Constraint[]): Constraint => ({ operator: "and", operands });

export const or = (...operands: Constraint[]): Constraint => ({ operator: "or", operands });

/** "set, but not yet processed" — the shape used by the answered and result-delivery scans. */
export const setButNot = (setField: string, notField: string): Constraint =>
    and(not(unset(setField)), unset(notField));

export class ThingRepository {
    constructor(private readonly client: A12Client) {}

    private toStored<T>(spec: ModelSpec, entry: { docRef: string; document: A12Document }): Stored<T> {
        return {
            docRef: entry.docRef,
            thingId: thingIdOf(entry.docRef),
            model: spec.model,
            data: fromDocument(spec, entry.document) as T,
        };
    }

    async get<T>(spec: ModelSpec, docRef: string): Promise<Stored<T>> {
        const found = await this.client.getDocument(docRef);
        return this.toStored<T>(spec, found);
    }

    /**
     * Update, merging onto the **raw stored document** rather than onto our projection of it.
     *
     * `MODIFY_DOCUMENT` is a whole-document replace, and this map deliberately does not cover
     * everything a Model declares — `Document_DM`'s attachment group, for one. Building the
     * outgoing document from the map alone therefore deleted the User's uploaded scan the moment
     * an Assistant touched the Document's classification. Silently, because an empty attachment
     * group is valid.
     *
     * Merging onto the raw document protects every field the map does not know about, including
     * ones added to a Model later.
     */
    async update<T extends Record<string, unknown>>(
        spec: ModelSpec,
        docRef: string,
        data: T,
    ): Promise<void> {
        const current = await this.client.getDocument(docRef);
        const rawRoot = (current.document[spec.root] ?? {}) as Record<string, unknown>;
        const mapped = toDocument(spec, { ...data, updatedAt: nowIso() });
        const mappedRoot = (mapped[spec.root] ?? {}) as Record<string, unknown>;
        await this.client.modifyDocument(docRef, {
            ...current.document,
            [spec.root]: { ...rawRoot, ...mappedRoot },
        });
    }

    /**
     * One page of Things.
     *
     * `sort` is opt-in and defaults to none, which means the store returns rows in whatever order
     * it likes — it promises none. Any caller that reasons about *which* rows it got (rather than
     * just "some matching rows") has to ask for an order, or it is reasoning about an arbitrary
     * window. That is what {@link byCreatedAt} is for.
     */
    async search<T>(
        spec: ModelSpec,
        constraint?: Constraint,
        pageSize = 100,
        sort?: QuerySpec["sort"],
    ): Promise<Stored<T>[]> {
        const result = await this.client.query({
            targetDocumentModel: spec.model,
            ...(constraint ? { constraint } : {}),
            ...(sort ? { sort } : {}),
            paging: { pageNumber: 0, pageSize },
        });
        return result.entries.map((entry: QueryEntry) => this.toStored<T>(spec, entry));
    }

    async findByIdempotencyKey<T>(spec: ModelSpec, key: string): Promise<Stored<T> | undefined> {
        const [first] = await this.search<T>(spec, eq(path(spec, "idempotencyKey"), key), 2);
        return first;
    }

    /**
     * Search-then-create.
     *
     * `ADD_DOCUMENT` assigns the docRef, so the client cannot choose an identifier and there is
     * no natural key to be idempotent under. Carrying the key *in* the Thing and looking it up
     * first is what makes creation safe to retry — which matters because lease recovery may
     * re-run a Turn that already created something.
     */
    async create<T extends Record<string, unknown>>(
        spec: ModelSpec,
        data: T & { idempotencyKey?: string },
    ): Promise<Stored<T>> {
        const key = data.idempotencyKey;
        if (key !== undefined) {
            // Omitting the field is a legitimate "I have no key". Supplying a blank one is a caller
            // bug, and treating it as "no key" switched deduplication off *silently* — on the very
            // path that exists to make a retried Turn safe.
            if (key.trim() === "") {
                throw new Error(
                    `Creating a ${spec.model} with a blank idempotency key would silently skip ` +
                        `deduplication. Omit the field if there genuinely is no key.`,
                );
            }
            // Longer than the store can search for. Caught here rather than inside the lookup, which
            // is where it used to fail — naming `exact_match` instead of the key. Note this ceiling
            // is shorter than the field's own maxLength, so a storable key can be unsearchable.
            if (key.length > EXACT_MATCH_MAX_LENGTH) {
                throw new Error(
                    `An idempotency key may be at most ${EXACT_MATCH_MAX_LENGTH} characters ` +
                        `(this one is ${key.length}); the store cannot search for a longer one.`,
                );
            }
            const existing = await this.findByIdempotencyKey<T>(spec, key);
            if (existing) return existing;
        }
        const stamp = nowIso();
        const withStamps = { ...data, createdAt: data["createdAt"] ?? stamp, updatedAt: stamp };
        const docRef = await this.client.addDocument(spec.model, toDocument(spec, withStamps));

        if (key !== undefined) {
            // Search-then-create has nothing atomic between the two halves and A12 has no unique
            // index, so two callers can both get here. Converging on one deterministically chosen
            // row means every caller ends up referring to the *same* Thing and the loser is left
            // unreferenced — which is the best available outcome, because the `runtime` identity
            // deliberately cannot delete (D-007).
            const all = await this.search<T>(spec, eq(path(spec, "idempotencyKey"), key), 5);
            if (all.length > 1) {
                const winner = [...all].sort((a, b) => a.docRef.localeCompare(b.docRef))[0]!;
                log.warn("two callers created a Thing under one idempotency key; converging", {
                    model: spec.model,
                    idempotencyKey: key,
                    kept: winner.docRef,
                    orphaned: all.filter((row) => row.docRef !== winner.docRef).map((row) => row.docRef),
                });
                return winner;
            }
        }
        return {
            docRef,
            thingId: thingIdOf(docRef),
            model: spec.model,
            data: withStamps as unknown as T,
        };
    }

    async delete(docRef: string): Promise<void> {
        await this.client.deleteDocument(docRef);
    }
}

export function nowIso(date: Date = new Date()): string {
    // A12 DateTimeType is modelled as yyyy-MM-dd'T'HH:mm:ss — no milliseconds, no zone suffix.
    return date.toISOString().replace(/\.\d{3}Z$/, "");
}

export function parseIso(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const parsed = Date.parse(value.endsWith("Z") ? value : `${value}Z`);
    return Number.isNaN(parsed) ? undefined : parsed;
}

export type {
    Assistant,
    Conversation,
    DocumentThing,
    Invoice,
    OpenQuestion,
    Party,
    ProcessThing,
    RuntimeState,
};
