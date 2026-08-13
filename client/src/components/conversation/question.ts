/**
 * Reading an Open Question out of the JSON document `useThingById` returns, in the terms two screens
 * render it: the Pending Question Bubble on the Conversation form, and the fallback Header on the
 * question's own form when its Conversation could not be read.
 *
 * Field *names*, capitalised, as `runtime/src/a12/things.ts` writes them — the same motion `entries.ts`
 * makes, for the same reason.
 */

export interface QuestionOption {
    readonly value: string;
    readonly label: string;
}

/** One Open Question, reduced to what a Transcript shows of it. */
export interface OpenQuestionHead {
    readonly assistantKey: string;
    readonly kind: string;
    readonly conversationId: string;
    readonly prompt: string;
    readonly options: readonly QuestionOption[];
}

export function readOpenQuestion(document: unknown): OpenQuestionHead {
    const fields = asRecord(asRecord(document)?.["OpenQuestion"]) ?? {};
    const options = fields["Options"];
    return {
        assistantKey: asString(fields["AssistantKey"]),
        kind: asString(fields["Kind"]),
        conversationId: asString(fields["ConversationId"]),
        prompt: asString(fields["Prompt"]),
        options: Array.isArray(options) ? options.flatMap(readOption) : []
    };
}

function readOption(candidate: unknown): QuestionOption[] {
    const fields = asRecord(candidate);
    if (fields === undefined) {
        return [];
    }
    const value = asString(fields["OptionValue"]);
    // A label is what the User reads; without one the value has to stand in for it.
    return [{ value, label: asString(fields["OptionLabel"]) || value }];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function asString(value: unknown): string {
    return typeof value === "string" ? value : "";
}
