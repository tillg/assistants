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

import { A12Client, type A12Document, type Constraint, type QueryEntry } from "./client.js";
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

export const unset = (field: string): Constraint => ({ operator: "undefined_match", field });

export const not = (operand: Constraint): Constraint => ({ operator: "not", operands: [operand] });

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

    async update<T extends Record<string, unknown>>(
        spec: ModelSpec,
        docRef: string,
        data: T,
    ): Promise<void> {
        const withStamp = { ...data, updatedAt: nowIso() };
        await this.client.modifyDocument(docRef, toDocument(spec, withStamp));
    }

    async search<T>(spec: ModelSpec, constraint?: Constraint, pageSize = 100): Promise<Stored<T>[]> {
        const result = await this.client.query({
            targetDocumentModel: spec.model,
            ...(constraint ? { constraint } : {}),
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
        if (data.idempotencyKey) {
            const existing = await this.findByIdempotencyKey<T>(spec, data.idempotencyKey);
            if (existing) return existing;
        }
        const stamp = nowIso();
        const withStamps = { ...data, createdAt: data["createdAt"] ?? stamp, updatedAt: stamp };
        const docRef = await this.client.addDocument(spec.model, toDocument(spec, withStamps));
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
