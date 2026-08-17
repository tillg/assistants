import { useDispatch } from "react-redux";
import styled from "styled-components";

import { openModule } from "../../sagas/openModule";

import { ICONS } from "../icons";

import { DashboardTile } from "./DashboardTile";
import { asOf } from "./readAt";
import { useAssistants } from "./useAssistants";

/**
 * The household's staff, by name. The smallest Tile, and the one that makes the application feel like it
 * has people in it.
 *
 * Every Assistant is the 🤖 the icon vocabulary already has — no per-Assistant glyph, because that would
 * be a Model change, a form change and a migration for decoration. A disabled one is dimmed and says so
 * rather than being hidden: it exists, and a User looking for it should find it here.
 */

const Disabled = styled.span`
    color: ${({ theme }) => theme.colors.text.secondaryColor};
`;

const More = styled.span`
    color: ${({ theme }) => theme.colors.text.secondaryColor};
    font-style: italic;
`;

export function AssistantsTile() {
    const dispatch = useDispatch();
    const assistants = useAssistants();

    const hidden = assistants.state === "ready" ? assistants.total - assistants.assistants.length : 0;

    return (
        <DashboardTile
            role="tile-assistants"
            icon={ICONS.assistant}
            title="Assistants"
            state={assistants.state}
            headline={assistants.state === "ready" ? assistants.total : undefined}
            body={
                assistants.state === "ready" ? (
                    <>
                        {assistants.assistants.map((assistant) =>
                            assistant.enabled ? (
                                <span key={assistant.key} data-role="tile-assistants-name">
                                    <span aria-hidden>{ICONS.assistant}</span> {assistant.name}
                                </span>
                            ) : (
                                <Disabled key={assistant.key} data-role="tile-assistants-name">
                                    <span aria-hidden>{ICONS.assistant}</span> {assistant.name} — disabled
                                </Disabled>
                            )
                        )}
                        {/* No silent caps: a page shown as if it were the set would be a quiet lie. */}
                        {hidden > 0 && <More data-role="tile-assistants-more">and {hidden} more</More>}
                    </>
                ) : undefined
            }
            footer={assistants.state === "ready" ? asOf(assistants.readAt) : undefined}
            onOpen={() => dispatch(openModule({ module: "Assistant" }))}
        />
    );
}
