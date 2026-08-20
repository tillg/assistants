import { useAssistantName } from "./conversation/useAssistantName";
import { ICONS } from "./icons";

/**
 * 🤖 and the Assistant's Name — the one way the system names an Assistant, wherever it names one.
 *
 * It lives here beside `icons.ts` rather than under `conversation/` because, like the icon vocabulary
 * it honours, it is no longer conversation-scoped: the Dashboard's Assistants Tile shows 🤖 + Name, and
 * so must the Transcript header and the Answer Surface. The glyph *is* the type (domain.md), which is why
 * there is no *(Assistant)* suffix beside it — that would say "Assistant" twice.
 *
 * The Name is resolved from the key by {@link useAssistantName}, which fails soft to the key. So a badge
 * for a renamed, disabled or deleted Assistant shows the key: it degrades to what the screen shows today
 * and never blanks. The 🤖 is `aria-hidden`, as every glyph in this vocabulary is — the Name beside it is
 * already the accessible text.
 */
export function AssistantBadge({ assistantKey }: { readonly assistantKey: string }) {
    const name = useAssistantName(assistantKey);
    return (
        <>
            <span aria-hidden>{ICONS.assistant}</span>
            <span>{name}</span>
        </>
    );
}
