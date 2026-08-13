import type { Speaker } from "./speaker";

/**
 * The four glyphs of domain.md's icon vocabulary, and the one place that knows them.
 *
 * Whenever the system has to say *who* or *stuck*, it says it with one of these. Three live only here;
 * the 🛑 lives here and in `Conversation_OM`'s expression column, because the overview renders its own.
 */
export const ICONS = {
    human: "👦🏼",
    assistant: "🤖",
    tool: "🛠️",
    blocked: "🛑"
} as const;

/** The icon a Speaker is shown with — Machinery has none, and that is the point of it. */
export function iconFor(speaker: Speaker): string | undefined {
    return speaker === "machinery" ? undefined : ICONS[speaker];
}
