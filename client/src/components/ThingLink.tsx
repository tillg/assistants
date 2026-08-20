import styled from "styled-components";

import { modelLabel, shortId, thingLabel } from "./conversation/thingLabel";
import { useThingById } from "./conversation/useThingById";
import { useThingPopup } from "./ThingPopup";

/**
 * The one way the system names a Thing: its own title, its Model in brackets, always a link that opens
 * the Thing's form in a read-only popup. Wherever a Thing is named — the Transcript header's *about* and
 * *called by* today, more sites tomorrow — it goes through here, so the naming rule lives in one place.
 *
 * It fails soft at every step, matching every read on these screens: a Thing that will not load shows a
 * short id, a Model outside the closed set shows no bracket, and the link still opens a popup that will
 * report what it could not read. No path blanks and no path throws.
 */

const Link = styled.button`
    padding: 0;
    border: none;
    background: none;
    color: ${({ theme }) => theme.colors.interaction.primaryInteractionColor};
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
`;

export interface ThingLinkProps {
    readonly model: string;
    readonly thingId: string;
    /** An optional leading word kept inside the link — the header's localized *about* / *called by*. */
    readonly prefix?: string;
}

export function ThingLink({ model, thingId, prefix }: ThingLinkProps) {
    const read = useThingById(model, thingId);
    const openPopup = useThingPopup();

    const label = read.state === "ready" ? thingLabel(model, read.document, thingId) : shortId(thingId);
    const name = modelLabel(model);
    const named = name !== undefined ? `${label} (${name})` : label;

    return (
        <Link type="button" data-role="thing-link" onClick={() => openPopup(model, thingId)}>
            {prefix !== undefined ? `${prefix} ${named}` : named}
        </Link>
    );
}
