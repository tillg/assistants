/**
 * Every Operation the Assistants can reach.
 *
 * The shape to notice: **any tool may answer `pending`**. Coding agents assume a tool returns in
 * seconds and block inside the Turn; our Operations are human-paced by design — a Manual
 * Connector, a question to the User, a call to another Assistant — so the pending path is the
 * normal path, not the exception. That single generalisation is what turns a coding-agent loop
 * into this one.
 */

import { log } from "../log.js";
import { ThingRepository, SPECS, nowIso, path as fieldPath, eq } from "../a12/things.js";
import type { ModelSpec } from "../a12/things.js";
import type { FireflyConnector, PostingSplit } from "../connectors/firefly.js";
import type { ToolContext, ToolDefinition, ToolOutcome } from "./registry.js";
import {
    isTriggerEligible,
    type Assistant,
    type Conversation,
    type OpenQuestion,
    type ThingModel,
} from "../domain/types.js";

export interface ToolDeps {
    things: ThingRepository;
    firefly: FireflyConnector;
    /** Raise an Open Question and return its ThingID. Shared by askUser and every Manual Connector. */
    raiseQuestion(input: {
        context: ToolContext;
        kind: "free-text" | "confirm" | "choice" | "perform";
        prompt: string;
        options?: Array<{ value: string; label: string }>;
        subjectThingId?: string;
    }): Promise<string>;
    /** Birth a child Conversation for another Assistant. */
    callAssistant(input: {
        context: ToolContext;
        assistantKey: string;
        prompt: string;
        subjectThingId?: string;
        subjectModel?: string;
    }): Promise<string>;
}

const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });

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
 * Models an Assistant may **read**. Everything the Runtime knows about — including its own
 * machinery, which an Assistant may inspect but never write.
 */
const READABLE_MODELS: readonly string[] = Object.keys(SPECS);

/** Models an Assistant may create or edit. Never its own machinery. */
const WRITABLE_MODELS: readonly string[] = ["Party_DM", "Document_DM", "Invoice_DM", "Process_DM"];

export function buildTools(deps: ToolDeps): ToolDefinition[] {
    const { things, firefly } = deps;

    const thingstoreCreate: ToolDefinition = {
        name: "thingstore.create",
        description:
            "Create a new Thing in the ThingStore. Returns its ThingID. Safe to retry: a repeated " +
            "call within the same turn returns the Thing already created rather than a duplicate.",
        mutating: true,
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
        async execute(args, context): Promise<ToolOutcome> {
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
        async reconcile(args, context): Promise<ToolOutcome | undefined> {
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

    const thingstoreGet: ToolDefinition = {
        name: "thingstore.get",
        description: "Read one Thing by its Model and ThingID.",
        mutating: false,
        parameters: {
            type: "object",
            properties: { model: str("The Model, e.g. Invoice_DM."), thingId: str("The ThingID.") },
            required: ["model", "thingId"],
        },
        async execute(args): Promise<ToolOutcome> {
            const model = String(args["model"] ?? "");
            const thingId = String(args["thingId"] ?? "");
            const found = await things.get(specFor(model), `${model}/${thingId}`);
            return { kind: "value", value: { thingId: found.thingId, model, fields: found.data } };
        },
    };

    const thingstoreUpdate: ToolDefinition = {
        name: "thingstore.update",
        description:
            "Update fields on an existing Thing. Supply only the fields you are changing; the " +
            "others are preserved.",
        mutating: true,
        parameters: {
            type: "object",
            properties: {
                model: str("The Model."),
                thingId: str("The ThingID."),
                fields: { type: "object", description: "Fields to change.", additionalProperties: true },
            },
            required: ["model", "thingId", "fields"],
        },
        async execute(args, context): Promise<ToolOutcome> {
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
            const merged = { ...current.data, ...((args["fields"] ?? {}) as Record<string, unknown>) };
            await things.update(spec, docRef, merged);
            void context;
            return { kind: "value", value: { thingId: current.thingId, model, updated: true } };
        },
        async reconcile(): Promise<ToolOutcome> {
            // An update sets named fields to values the model chose, so applying it twice reaches
            // the same state. Reporting the uncertainty is enough; the next Turn can re-read.
            return {
                kind: "error",
                message:
                    "This update was interrupted and may or may not have applied. Read the Thing back before assuming either way.",
            };
        },
    };

    const thingstoreSearch: ToolDefinition = {
        name: "thingstore.search",
        description:
            "Find Things of one Model. Without a field filter it returns the most recent ones. " +
            "Filtering matches a field exactly.",
        mutating: false,
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
        async execute(args): Promise<ToolOutcome> {
            const model = String(args["model"] ?? "");
            const spec = specFor(model);
            const field = args["field"] ? String(args["field"]) : undefined;
            const limit = Math.min(Number(args["limit"] ?? 25) || 25, 100);
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
            const constraint =
                field !== undefined
                    ? eq(fieldPath(spec, field), String(args["value"] ?? ""))
                    : undefined;
            const found = await things.search<Record<string, unknown>>(spec, constraint, limit);
            return {
                kind: "value",
                value: found.map((thing) => ({ thingId: thing.thingId, model, fields: thing.data })),
            };
        },
    };

    const askUser: ToolDefinition = {
        name: "ui.askUser",
        description:
            "Ask the User a question and stop until they answer. Use this for any decision that is " +
            "the User's to make — approving a booking, resolving an ambiguity, confirming a total. " +
            "The conversation suspends; you will be resumed with the answer.",
        mutating: true,
        parameters: {
            type: "object",
            properties: {
                kind: {
                    type: "string",
                    enum: ["free-text", "confirm", "choice"],
                    description: "free-text for open answers, confirm for yes/no, choice for a list.",
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
        async execute(args, context): Promise<ToolOutcome> {
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
        async reconcile(_args, context): Promise<ToolOutcome | undefined> {
            const existing = await things.findByIdempotencyKey<OpenQuestion>(
                SPECS.OpenQuestion_DM,
                context.idempotencyKey,
            );
            if (!existing) return undefined;
            return existing.data.answeredAt
                ? { kind: "value", value: { answered: true } }
                : { kind: "pending", waitingFor: "user", questionId: existing.thingId };
        },
    };

    const assistantCall: ToolDefinition = {
        name: "assistant.call",
        description:
            "Ask another Assistant to do something. The call is asynchronous: a new conversation is " +
            "started for them, and you are resumed when they finish.",
        mutating: true,
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
        async execute(args, context): Promise<ToolOutcome> {
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
        async reconcile(args, context): Promise<ToolOutcome | undefined> {
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

    const listAccounts: ToolDefinition = {
        name: "bookkeeping.listAccounts",
        description:
            "List the chart of accounts. Always look here before booking — account names must match " +
            "exactly, and you may not invent one.",
        mutating: false,
        parameters: { type: "object", properties: {} },
        async execute(): Promise<ToolOutcome> {
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

    const postTransaction: ToolDefinition = {
        name: "bookkeeping.postTransaction",
        description:
            "Book a balanced transaction into the books. Account names must already exist — call " +
            "bookkeeping.listAccounts first. Safe to retry: booking the same thing twice is a no-op.",
        mutating: true,
        parameters: {
            type: "object",
            properties: {
                groupTitle: str("A short title for the whole transaction."),
                thingId: str("The ThingID of the Invoice this books, so the books link back to it."),
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
        async execute(args, context): Promise<ToolOutcome> {
            const splits = (args["splits"] ?? []) as PostingSplit[];
            if (!Array.isArray(splits) || splits.length === 0) {
                return { kind: "error", message: "postTransaction needs at least one split." };
            }
            const result = await firefly.postTransaction({
                groupTitle: args["groupTitle"] ? String(args["groupTitle"]) : undefined,
                externalId: context.idempotencyKey,
                thingId: args["thingId"] ? String(args["thingId"]) : undefined,
                splits,
            });
            return {
                kind: "value",
                value: {
                    transactionId: result.id,
                    alreadyExisted: result.alreadyExisted,
                },
            };
        },
        async reconcile(_args, context): Promise<ToolOutcome | undefined> {
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

    const getBalance: ToolDefinition = {
        name: "bookkeeping.getBalance",
        description: "The current balance of one account.",
        mutating: false,
        parameters: {
            type: "object",
            properties: { account: str("Exact account name.") },
            required: ["account"],
        },
        async execute(args): Promise<ToolOutcome> {
            return { kind: "value", value: await firefly.getBalance(String(args["account"] ?? "")) };
        },
    };

    const listOpenItems: ToolDefinition = {
        name: "bookkeeping.listOpenItems",
        description:
            "Unpaid invoices and unclaimed reimbursements — the non-zero balances on payable and " +
            "receivable accounts.",
        mutating: false,
        parameters: { type: "object", properties: {} },
        async execute(): Promise<ToolOutcome> {
            return { kind: "value", value: await firefly.listOpenItems() };
        },
    };

    const getBudgetReport: ToolDefinition = {
        name: "bookkeeping.getBudgetReport",
        description: "Budgets and what has been spent against them.",
        mutating: false,
        parameters: { type: "object", properties: {} },
        async execute(): Promise<ToolOutcome> {
            return { kind: "value", value: await firefly.listBudgets() };
        },
    };

    const createAccount: ToolDefinition = {
        name: "bookkeeping.createAccount",
        description: "Add an account to the chart of accounts.",
        mutating: true,
        parameters: {
            type: "object",
            properties: {
                name: str("The account name."),
                type: str("asset | expense | revenue | liability."),
                currencyCode: str("Default EUR."),
            },
            required: ["name", "type"],
        },
        async execute(args): Promise<ToolOutcome> {
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
        async reconcile(args): Promise<ToolOutcome> {
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
        description: string;
        properties: Record<string, unknown>;
        required: string[];
        renderPrompt(args: Record<string, unknown>): string;
    }): ToolDefinition {
        return {
            name: input.name,
            description: `${input.description} This is performed by the User by hand, so it may take a while.`,
            mutating: true,
            parameters: { type: "object", properties: input.properties, required: input.required },
            async execute(args, context): Promise<ToolOutcome> {
                const questionId = await deps.raiseQuestion({
                    context,
                    kind: "perform",
                    prompt: input.renderPrompt(args),
                    subjectThingId: context.conversation.data.subjectThingId,
                });
                return { kind: "pending", waitingFor: "tool", questionId };
            },
            async reconcile(_args, context): Promise<ToolOutcome | undefined> {
                const existing = await things.findByIdempotencyKey<OpenQuestion>(
                    SPECS.OpenQuestion_DM,
                    context.idempotencyKey,
                );
                if (!existing) return undefined;
                return existing.data.answeredAt
                    ? { kind: "value", value: { done: true } }
                    : { kind: "pending", waitingFor: "tool", questionId: existing.thingId };
            },
        };
    }

    const requestText = manualConnector({
        name: "document.requestText",
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
