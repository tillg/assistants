/** The eight Models, as the Runtime sees them. */

export type ThingModel =
    | "Party_DM"
    | "Document_DM"
    | "Invoice_DM"
    | "Process_DM"
    | "Assistant_DM"
    | "Conversation_DM"
    | "OpenQuestion_DM"
    | "RuntimeState_DM";

/**
 * The Models an Assistant may be triggered by when a Thing materialises.
 *
 * This allow-list is a safety mechanism, not a convenience. An Assistant is a Thing and a
 * Conversation is a Thing (ADR-0003), so without it the Runtime would trigger on its own
 * output and feed itself forever.
 */
export const TRIGGER_ELIGIBLE_MODELS: readonly ThingModel[] = [
    "Document_DM",
    "Invoice_DM",
    "Process_DM",
    "Party_DM",
];

export function isTriggerEligible(model: string): model is ThingModel {
    return (TRIGGER_ELIGIBLE_MODELS as readonly string[]).includes(model);
}

/** A ThingID identifies and nothing more (ADR-0002); a ThingRef adds the Model as convenience. */
export interface ThingRef {
    thingId: string;
    model: string;
}

export interface MachineFields {
    idempotencyKey?: string;
    createdByConversationId?: string;
    createdAt?: string;
    updatedAt?: string;
}

export interface Party extends MachineFields {
    kind?: string;
    role?: string;
    name?: string;
    legalName?: string;
    email?: string;
    phone?: string;
    street?: string;
    postcode?: string;
    city?: string;
    country?: string;
    iban?: string;
    notes?: string;
}

export interface DocumentThing extends MachineFields {
    title?: string;
    receivedAt?: string;
    source?: string;
    mediaType?: string;
    externalRef?: string;
    extractedText?: string;
    classification?: string;
    classifiedThingId?: string;
    classifiedModel?: string;
    classificationNote?: string;
}

export interface Invoice extends MachineFields {
    invoiceNumber?: string;
    issuedByPartyThingId?: string;
    issuerName?: string;
    issueDate?: string;
    dueDate?: string;
    serviceDate?: string;
    amountGross?: number;
    amountNet?: number;
    currency?: string;
    subject?: string;
    recipientName?: string;
    documentThingId?: string;
    processThingId?: string;
    notes?: string;
}

export interface ProcessStep {
    seq?: number;
    title?: string;
    state?: string;
    note?: string;
    doneAt?: string;
}

export interface ProcessRelated {
    thingId?: string;
    model?: string;
    note?: string;
}

export interface ProcessThing extends MachineFields {
    title?: string;
    kind?: string;
    status?: string;
    summary?: string;
    steps?: ProcessStep[];
    related?: ProcessRelated[];
}

export interface Skill {
    name?: string;
    instructions?: string;
}

export type TriggerKind = "thing-materialised" | "assistant-call" | "schedule";

export interface Trigger {
    kind?: string;
    modelFilter?: string;
    cron?: string;
}

export interface Grant {
    operationKey?: string;
}

export interface Assistant extends MachineFields {
    key?: string;
    name?: string;
    description?: string;
    systemPrompt?: string;
    llmModel?: string;
    enabled?: boolean;
    maxTurns?: number;
    skills?: Skill[];
    triggers?: Trigger[];
    grants?: Grant[];
}

export type ConversationStatus = "running" | "waiting" | "done" | "failed";
export type WaitingFor = "user" | "tool" | "assistant";
export type FinishReason = "answered" | "wants-tools" | "length" | "limit" | "error";

export type EntryKind =
    | "system"
    | "prompt"
    | "assistant"
    | "tool-intent"
    | "tool-result"
    | "question"
    | "answer"
    | "timeout"
    | "error"
    | "note"
    /**
     * The Runtime asked the User to approve one Operation with one set of arguments.
     *
     * The only Entry kind written by the Runtime rather than derived from the model or the User, and
     * the only one that carries **no `text`**: `buildMessages` turns an unrecognised kind with a
     * `text` into a user message, which between a `tool-intent` and its `tool-result` would put a
     * user turn where both providers require the tool result. It is a machine record, read only by
     * the approval walk-back; the words the User sees live on the Open Question, which is their
     * Authority (ADR-0006).
     */
    | "approval-request";

export interface Entry {
    seq?: number;
    at?: string;
    role?: string;
    kind?: string;
    text?: string;
    toolName?: string;
    toolArgs?: string;
    toolResult?: string;
    idempotencyKey?: string;
    /**
     * The Open Question this Entry is about.
     *
     * Set on every `answer` Entry by the watcher's answered scan, and on every `approval-request`.
     * Only approvals read it — but every answer carries it, because the alternative is a scan that
     * has to know which questions matter.
     */
    questionId?: string;
    /** On an `approval-request`: {@link canonicalArgsHash} of the call the approval is bound to. */
    argsHash?: string;
    /** What the model charged for the Turn that wrote this Entry. Zero from a scripted provider. */
    promptTokens?: number;
    completionTokens?: number;
}

export interface Conversation extends MachineFields {
    assistantKey?: string;
    title?: string;
    subjectThingId?: string;
    subjectModel?: string;
    /**
     * The due instant this Conversation was born to serve, as a canonical UTC ISO-8601 string.
     *
     * Set only by the schedule scan, and indexed: "did Monday's chase run?" is one query against
     * the Conversations list rather than a `lastScheduledRunAt` held in a second place (ADR-0006).
     * A String rather than a DateTime because the scan matches it with `exact_match`.
     */
    scheduledFor?: string;
    status?: ConversationStatus;
    waitingFor?: WaitingFor | "";
    finishReason?: FinishReason | "";
    turnCount?: number;
    maxTurns?: number;
    wakeAt?: string;
    leaseUntil?: string;
    parentConversationId?: string;
    currentQuestionId?: string;
    resultDeliveredAt?: string;
    escalationCount?: number;
    result?: string;
    lastError?: string;
    entries?: Entry[];
}

export type QuestionKind = "free-text" | "confirm" | "choice" | "perform";

export interface QuestionOption {
    value?: string;
    label?: string;
}

export interface OpenQuestion extends MachineFields {
    conversationId?: string;
    assistantKey?: string;
    seq?: number;
    kind?: string;
    subjectThingId?: string;
    prompt?: string;
    options?: QuestionOption[];
    text?: string;
    choice?: string;
    confirmed?: boolean;
    answeredAt?: string;
}

export interface WatermarkDocRef {
    docRef?: string;
}

export interface RuntimeState extends MachineFields {
    singletonKey?: string;
    watermark?: string;
    watermarkDocRefs?: WatermarkDocRef[];
    paused?: boolean;
    birthsThisHour?: number;
    birthWindowStartedAt?: string;
    heartbeatAt?: string;
    lastError?: string;
}

/** A Thing as loaded: its identity plus its fields. */
export interface Stored<T> {
    docRef: string;
    thingId: string;
    model: string;
    data: T;
}

export function thingIdOf(docRef: string): string {
    const slash = docRef.indexOf("/");
    return slash === -1 ? docRef : docRef.slice(slash + 1);
}

export function modelOf(docRef: string): string {
    const slash = docRef.indexOf("/");
    return slash === -1 ? "" : docRef.slice(0, slash);
}

export function docRefOf(model: string, thingId: string): string {
    return `${model}/${thingId}`;
}
