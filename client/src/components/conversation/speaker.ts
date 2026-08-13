/**
 * domain.md's Speaker table, as code.
 *
 * Who an Entry is *from* is derived from its `kind`, never from its `role`: `prompt` and `answer` are
 * both `role: user` and only one of them is the human, so reading `role` would put the Runtime's
 * briefing in the User's colour — a lie about who said it.
 */

/** Who an Entry is from, as the User reads it. */
export type Speaker = "human" | "assistant" | "tool" | "machinery";

export type Side = "left" | "right" | "centre";

export type Shape = "prose" | "question" | "receipt" | "meta";

export interface SpeakerRole {
    readonly speaker: Speaker;
    readonly side: Side;
    readonly shape: Shape;
    /** True for what is long and read once: the system prompt, the briefing, and a Receipt. */
    readonly collapsed: boolean;
    /** `timeout` and `error` are the only Entries reporting that something went wrong. */
    readonly warning: boolean;
    /** The words of a meta line — the kind verbatim, unless domain.md gives it better ones. */
    readonly label?: string;
}

/** The Assistant asking is speech, and the prompt is in the call's arguments. */
const ASK_USER = "ui.askUser";

const ASSISTANT: SpeakerRole = { speaker: "assistant", side: "left", shape: "prose", collapsed: false, warning: false };
const HUMAN: SpeakerRole = { speaker: "human", side: "right", shape: "prose", collapsed: false, warning: false };
const RECEIPT: SpeakerRole = { speaker: "tool", side: "left", shape: "receipt", collapsed: true, warning: false };
const QUESTION: SpeakerRole = {
    speaker: "assistant",
    side: "left",
    shape: "question",
    collapsed: false,
    warning: false
};

function machinery(label: string, options: { collapsed?: boolean; warning?: boolean } = {}): SpeakerRole {
    return {
        speaker: "machinery",
        side: "centre",
        shape: "meta",
        collapsed: options.collapsed ?? false,
        warning: options.warning ?? false,
        label
    };
}

/** Reads a Speaker, a side and a shape off an Entry's kind — and off its Operation, for `ui.askUser`. */
export function speakerFor(kind: string, toolName?: string): SpeakerRole {
    switch (kind) {
        case "assistant":
            return ASSISTANT;
        case "answer":
            return HUMAN;
        case "tool-intent":
            return toolName === ASK_USER ? QUESTION : RECEIPT;
        case "tool-result":
            return RECEIPT;
        case "system":
            return machinery("system", { collapsed: true });
        case "prompt":
            return machinery("prompt", { collapsed: true });
        case "note":
            return machinery("note");
        case "timeout":
            return machinery("timeout", { warning: true });
        case "error":
            return machinery("error", { warning: true });
        case "approval-request":
            return machinery("🛑 approval requested");
        default:
            // A new kind must degrade, never disappear, so its own name is what the meta line says.
            return machinery(kind);
    }
}
