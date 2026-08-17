import type { Speaker } from "./conversation/speaker";

/**
 * The glyphs of domain.md's icon vocabulary, and the one place that knows them.
 *
 * It sits here rather than in `conversation/` because it is no longer conversation-scoped: the Dashboard
 * shows the same 🤖 beside an Assistant that the Transcript shows beside its words, and a shared
 * vocabulary living in a folder named after one of its consumers is how the single-source claim quietly
 * becomes false.
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

/**
 * Where. Labels for the Dashboard's destinations — a different job from {@link ICONS}, so a different
 * constant: `ICONS` says *who is speaking* or *this is stuck* and means it identically wherever it
 * appears, while these label a place and mean nothing outside the Dashboard. The Assistants Tile is
 * deliberately absent: every Assistant is the 🤖 `ICONS` already has, not a fifth robot.
 */
export const PLACE_ICONS = {
    conversations: "🗣",
    documents: "📄",
    bookkeeping: "💰",
    // Two glyphs for one place, which is not a contradiction: 💰 labels the *door* to the books, and
    // these two label what the Dashboard reads out of them. A single 💰 on all three would make the
    // row of Tiles unreadable at a glance, which is the only job an icon has here.
    transactions: "💳",
    accounts: "🏦"
} as const;

/** The icon a Speaker is shown with — Machinery has none, and that is the point of it. */
export function iconFor(speaker: Speaker): string | undefined {
    return speaker === "machinery" ? undefined : ICONS[speaker];
}
