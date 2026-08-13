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
 * The agentic half of the domain, as the tests need to see it.
 *
 * Everything here reads the ThingStore, because the ThingStore is the only Authority for pending
 * work (ADR-0004): there is no Runtime API to ask, and there is deliberately nothing else to
 * scan. Waiting is a row, not a process — which is precisely what `flow/2-restart.spec.ts`
 * proves by killing the process.
 */

import { AGENT_TIMEOUT_MS, E2E_PREFIX } from "./config";
import { and, eq, nowIso, type ThingEntry, type ThingStore, thingIdOf, waitFor } from "./thingstore";

export const RECEPTIONIST = "receptionist";
export const ACCOUNTANT = "accountant";

/** What the scripted model was recorded against: a private German medical invoice for 96.50 EUR. */
export const INVOICE_AMOUNT = "96.50";
export const INVOICE_CURRENCY = "EUR";

export const INVOICE_TEXT = [
    "Gemeinschaftspraxis Dr. med. A. Meyer & Kollegen",
    "Hauptstraße 12, 50226 Frechen",
    "",
    "Privatliquidation",
    "Rechnungsnummer: 2026-118",
    "Rechnungsdatum: 01.08.2026",
    "Behandlungsdatum: 24.07.2026",
    "Patient: Till Gartner",
    "",
    "Beratung und Verbandwechsel (GOÄ 1, 2006)",
    "",
    "Gesamtbetrag: 96,50 EUR",
    "Zahlbar bis: 31.08.2026"
].join("\n");

export interface RaisedQuestion {
    docRef: string;
    thingId: string;
    conversationThingId: string;
    createdAt: string;
    prompt: string;
    assistantKey: string;
}

const conversationPath = (field: string) => `/Conversation/${field}`;

/**
 * Drop an arriving Document into the ThingStore, the way the world drops one on the doormat.
 *
 * `CreatedAt` is ours rather than `__meta.createdAt`, and the watcher's birth scan filters on it,
 * so it has to be set here or the Thing never looks new.
 */
export async function createArrivingDocument(
    store: ThingStore,
    runId: string
): Promise<{ docRef: string; thingId: string; title: string }> {
    const stamp = nowIso();
    const title = `${E2E_PREFIX} Arztrechnung ${runId}`;
    const docRef = await store.addDocument("Document_DM", {
        Document: {
            Title: title,
            ReceivedAt: stamp,
            Source: "scan",
            MediaType: "text/plain",
            ExtractedText: INVOICE_TEXT,
            IdempotencyKey: `${E2E_PREFIX}:document:${runId}`
            // No `CreatedAt` and no `UpdatedAt`, deliberately. Those are two of the four machine
            // fields, they are on no form, and A12's form engine has no save hook that could set
            // one — so a Document a *human* creates in the web application has neither. This helper
            // used to stamp both, which meant the suite tested a shape only the Runtime and the demo
            // loader produce, and never the shape the User produces. That is how a Document created
            // in the UI came to be invisible to the trigger watcher for ever with a green suite.
            //
            // Leaving them out costs one extra scan — the Runtime stamps `CreatedAt` on a Thing that
            // has none and births it on the next pass — and buys the guard for that bug.
        }
    });
    return { docRef, thingId: thingIdOf(docRef), title };
}

/** Wait until the Receptionist has been born for this Document — the first sign of life. */
export async function waitForBirth(
    store: ThingStore,
    documentThingId: string,
    timeoutMs = AGENT_TIMEOUT_MS
): Promise<ThingEntry> {
    return waitFor(
        `a ${RECEPTIONIST} Conversation about Document ${documentThingId}`,
        async () => {
            const [born] = await store.query(
                "Conversation_DM",
                and(
                    eq(conversationPath("AssistantKey"), RECEPTIONIST),
                    eq(conversationPath("SubjectThingId"), documentThingId)
                )
            );
            return born;
        },
        timeoutMs,
        2_000
    );
}

async function conversationsFor(store: ThingStore, documentThingId: string): Promise<ThingEntry[]> {
    const born = await store.query(
        "Conversation_DM",
        and(eq(conversationPath("AssistantKey"), RECEPTIONIST), eq(conversationPath("SubjectThingId"), documentThingId))
    );
    if (born.length === 0) {
        return [];
    }

    const children = await Promise.all(
        born.map((parent) =>
            store.query("Conversation_DM", eq(conversationPath("ParentConversationId"), parent.thingId))
        )
    );
    return [...born, ...children.flat()];
}

const body = (entry: ThingEntry, root: string): Record<string, unknown> =>
    (entry.document[root] ?? {}) as Record<string, unknown>;

/**
 * Wait until some Conversation in this Document's tree is waiting on the User, and return the
 * Open Question it is waiting on.
 *
 * The link is `Conversation.currentQuestionId`, not a search over Open Questions: the question's
 * own `subjectThingId` is empty for a called Assistant, and "which question is this run's?" has
 * to be answerable without guessing at timestamps.
 *
 * `excluding` is what makes a *second* question findable. One booking now raises two — the one the
 * Assistant chose to ask and the approval the Runtime demands (ADR-0018) — and they are answered one
 * after the other, so the caller has to be able to say "not that one again".
 */
export async function waitForRaisedQuestion(
    store: ThingStore,
    documentThingId: string,
    timeoutMs = AGENT_TIMEOUT_MS,
    excluding: readonly string[] = []
): Promise<RaisedQuestion> {
    return waitFor(
        `an Open Question raised for Document ${documentThingId}` +
            (excluding.length > 0 ? ` other than ${excluding.join(", ")}` : ""),
        async () => {
            for (const conversation of await conversationsFor(store, documentThingId)) {
                const data = body(conversation, "Conversation");
                const questionId = String(data["CurrentQuestionId"] ?? "");
                if (!questionId || excluding.includes(questionId)) {
                    continue;
                }

                const docRef = `OpenQuestion_DM/${questionId}`;
                const question = await store.body(docRef, "OpenQuestion");
                return {
                    docRef,
                    thingId: questionId,
                    conversationThingId: conversation.thingId,
                    createdAt: String(question["CreatedAt"] ?? ""),
                    prompt: String(question["Prompt"] ?? ""),
                    assistantKey: String(question["AssistantKey"] ?? "")
                } satisfies RaisedQuestion;
            }
            return undefined;
        },
        timeoutMs,
        2_000
    );
}

/**
 * Wait until some Conversation in this Document's tree records a tool result containing `contains`.
 *
 * A call the Runtime refuses leaves an Entry, not an absence — that is the point of writing the
 * intent before running anything — so the transcript is the only place a test can see *why* an
 * Operation did nothing. Same tree, same poll and same interval as everything else here: the
 * Conversation is found through the Document that gave birth to it, never by guessing.
 */
export async function waitForToolResult(
    store: ThingStore,
    documentThingId: string,
    contains: string,
    timeoutMs = AGENT_TIMEOUT_MS
): Promise<Record<string, unknown>> {
    return waitFor(
        `a tool result containing "${contains}" in some Conversation about Document ${documentThingId}`,
        async () => {
            for (const conversation of await conversationsFor(store, documentThingId)) {
                const entries = (body(conversation, "Conversation")["Entries"] ?? []) as Array<Record<string, unknown>>;
                const hit = entries.find((entry) => String(entry["ToolResult"] ?? "").includes(contains));
                if (hit) {
                    return hit;
                }
            }
            return undefined;
        },
        timeoutMs,
        2_000
    );
}

/** Is this Open Question still unanswered and still the one its Conversation waits on? */
export async function questionIsPending(store: ThingStore, question: RaisedQuestion): Promise<boolean> {
    const [asked, conversation] = await Promise.all([
        store.body(question.docRef, "OpenQuestion"),
        store.body(`Conversation_DM/${question.conversationThingId}`, "Conversation")
    ]);
    return (
        !asked["AnsweredAt"] &&
        String(conversation["CurrentQuestionId"] ?? "") === question.thingId &&
        String(conversation["Status"] ?? "") === "waiting"
    );
}

/** Wait until every Conversation in this Document's tree has finished. */
export async function waitForConversationsDone(
    store: ThingStore,
    documentThingId: string,
    timeoutMs = AGENT_TIMEOUT_MS
): Promise<void> {
    await waitFor(
        `every Conversation about Document ${documentThingId} to reach 'done'`,
        async () => {
            const conversations = await conversationsFor(store, documentThingId);
            if (conversations.length === 0) {
                return undefined;
            }
            const statuses = conversations.map((entry) => String(body(entry, "Conversation")["Status"] ?? ""));
            if (statuses.includes("failed")) {
                throw new Error(`A Conversation failed: ${statuses.join(", ")}`);
            }
            return statuses.every((status) => status === "done") ? true : undefined;
        },
        timeoutMs,
        2_000
    );
}

/** Wait until a Conversation has moved past waiting on the User — the answer was consumed. */
export async function waitForConversationToContinue(
    store: ThingStore,
    question: RaisedQuestion,
    timeoutMs = AGENT_TIMEOUT_MS
): Promise<string> {
    return waitFor(
        `Conversation ${question.conversationThingId} to continue past the answer to ${question.thingId}`,
        async () => {
            const data = await store.body(`Conversation_DM/${question.conversationThingId}`, "Conversation");
            const status = String(data["Status"] ?? "");
            // Past **this** question, not past waiting altogether. Answering the Accountant's own
            // "book this invoice?" moves it straight onto the Runtime's approval (ADR-0018), so it is
            // `waiting` on `user` again within one scan — and "it is no longer waiting" would be a
            // condition this Conversation legitimately never meets. The consumed answer is what
            // "continued" means, and `currentQuestionId` is where that is recorded.
            const stillOnIt = String(data["CurrentQuestionId"] ?? "") === question.thingId;
            return stillOnIt ? undefined : status;
        },
        timeoutMs,
        2_000
    );
}
