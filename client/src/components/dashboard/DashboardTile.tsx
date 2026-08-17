import type { ReactNode } from "react";
import styled from "styled-components";

import { Card } from "@com.mgmtp.a12.widgets/widgets-core";

/**
 * The only component that knows what a Tile looks like: an icon, a title, and then three **optional**
 * slots — a headline, a body, and a footer. It renders the three states itself, so no Tile writes its
 * own spinner and no Tile writes its own error line.
 *
 * Headline and footer are optional because the bookkeeping Tile has neither: it issues no query, so it
 * has no read instant to put in a footer, and domain.md is explicit that a Tile with no honest headline
 * shows none rather than inventing one. Making the slots optional is the smaller decision than a second
 * chrome — three of four Tiles share the click target, the link role, the theming and the three states,
 * and only the *contents* differ.
 *
 * `data-state` exists for Playwright. The Tiles fetch outside the activity machinery, so no progress
 * overlay appears and `BasePage.finishedLoading()` returns while the numbers are still in flight; an
 * attribute the spec can wait on is the alternative to an arbitrary sleep.
 */

export type TileState = "loading" | "ready" | "error";

export interface DashboardTileProps {
    /** The `data-role` this Tile is found by, in tests and in the e2e page object. */
    readonly role: string;
    readonly icon: string;
    readonly title: string;
    readonly state: TileState;
    /** The one big number. Absent on a Tile that has no honest one. */
    readonly headline?: ReactNode;
    readonly body?: ReactNode;
    /** Usually the read instant. Absent on the Tile that read nothing. */
    readonly footer?: ReactNode;
    /** Opens a module. Ignored when `href` is given. */
    readonly onOpen?: () => void;
    /** Leaves the application entirely — a real anchor, so it is a link to a keyboard and a reader. */
    readonly href?: string;
}

/**
 * The A12 `Card` ships transparent and borderless — its own chrome comes from a stylesheet this
 * application does not load — so the edge is drawn here, in the same theme tokens `TranscriptHeader`
 * uses. Both themes therefore keep working with no per-Tile colour decision.
 */
const Frame = styled.div`
    /*
     * The layout's grid row stretches its columns, and the platform wraps each view in a full-height
     * div — so a Tile left to itself is floor-to-ceiling. Fitting the content takes the Tile back to its
     * own size, and the shared minimum keeps the row of four reading as a row rather than a staircase.
     */
    height: fit-content;
    min-height: 11rem;
    overflow: hidden;
    border: 1px solid ${({ theme }) => theme.colors.divider.color};
    border-radius: 0.25rem;
    background: ${({ theme }) => theme.colors.background.primaryBackground};

    & > * {
        height: 100%;
    }
`;

const Inside = styled.div`
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 1rem;
    color: ${({ theme }) => theme.colors.text.color};
`;

const Heading = styled.div`
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    font-weight: 600;
`;

const Headline = styled.div`
    font-size: 2rem;
    font-weight: 600;
    line-height: 1.1;
`;

/** The same height the headline occupies, so a Tile does not jump when its number arrives. */
const Placeholder = styled(Headline)`
    width: 3ch;
    border-radius: 0.2rem;
    background: ${({ theme }) => theme.colors.divider.color};
    color: transparent;
`;

const Body = styled.div`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.9em;
`;

const Footer = styled.div`
    color: ${({ theme }) => theme.colors.text.secondaryColor};
    font-size: 0.8em;
`;

const Sorry = styled.div`
    color: ${({ theme }) => theme.colors.variant.text.warning};
    font-size: 0.9em;
`;

const Anchor = styled.a`
    display: block;
    height: 100%;
    color: inherit;
    text-decoration: none;
`;

export function DashboardTile({ role, icon, title, state, headline, body, footer, onOpen, href }: DashboardTileProps) {
    const inside = (
        <Inside>
            <Heading>
                <span aria-hidden>{icon}</span>
                <span>{title}</span>
            </Heading>

            {state === "loading" && <Placeholder data-role={`${role}-headline-placeholder`}>—</Placeholder>}
            {state === "error" && <Sorry data-role={`${role}-error`}>could not read this</Sorry>}

            {state === "ready" && headline !== undefined && (
                <Headline data-role={`${role}-headline`}>{headline}</Headline>
            )}
            {state === "ready" && body !== undefined && <Body data-role={`${role}-body`}>{body}</Body>}
            {state === "ready" && footer !== undefined && <Footer data-role={`${role}-footer`}>{footer}</Footer>}
        </Inside>
    );

    return (
        <Frame data-role={role} data-state={state}>
            <Card>
                {href === undefined ? (
                    <Card.ActionArea onClick={onOpen}>{inside}</Card.ActionArea>
                ) : (
                    // A real anchor, not an ActionArea with a handler: the books are another application,
                    // and `rel` because `target="_blank"` without it hands the opened page a
                    // `window.opener` handle.
                    <Anchor href={href} target="_blank" rel="noopener noreferrer">
                        {inside}
                    </Anchor>
                )}
            </Card>
        </Frame>
    );
}
