import type { ReactNode } from "react";
import styled, { css } from "styled-components";

import { Card } from "@com.mgmtp.a12.widgets/widgets-core";

/**
 * The only component that knows what a Tile looks like: an icon, a title, and then three **optional**
 * slots — a headline, a body, and a footer. It renders the three states itself, so no Tile writes its
 * own spinner and no Tile writes its own error line.
 *
 * Headline and footer are optional because not every Tile has one: a Tile with no honest headline shows
 * none rather than inventing one (domain.md) — and so shows no loading placeholder where one would have
 * gone either, because a grey block that appears and vanishes is a layout jump promising a number that
 * is never coming. `expectsHeadline` is how a Tile whose headline is still in flight says so.
 *
 * Making the slots optional is the smaller decision than a second chrome — the Tiles share the click
 * target, the link role, the theming and the three states, and only the *contents* differ.
 *
 * There are two **variants**, and the second exists because the bookkeeping door has nothing to say at
 * all. A *tile* is a summary: a frame, a minimum height, and the three slots. A *button* is a control:
 * a label, a destination, an `↗`, and none of the slots. A thing with nothing to say should not be
 * shaped like the things that do — drawn as a tile it read as a tile whose number had failed to load,
 * which is exactly the wrong sentence for a door that is working perfectly.
 *
 * It is still one component rather than two. Both variants share the anchor, the `rel`, the theming and
 * the `data-role` convention; a second chrome would duplicate all of that to change a background colour
 * and delete three slots.
 *
 * `data-state` exists for Playwright. The Tiles fetch outside the activity machinery, so no progress
 * overlay appears and `BasePage.finishedLoading()` returns while the numbers are still in flight; an
 * attribute the spec can wait on is the alternative to an arbitrary sleep. `data-variant` is there for
 * the same reason: a Tile silently reverting to the wrong shape is a thing a spec should catch.
 */

export type TileState = "loading" | "ready" | "error";

/** A summary, or the control that opens the place a summary came from. */
export type TileVariant = "tile" | "button";

export interface DashboardTileProps {
    /** The `data-role` this Tile is found by, in tests and in the e2e page object. */
    readonly role: string;
    readonly icon: string;
    readonly title: string;
    readonly state: TileState;
    /** Defaults to `"tile"`. A `"button"` renders none of the three slots. */
    readonly variant?: TileVariant;
    /** The one big number. Absent on a Tile that has no honest one. */
    readonly headline?: ReactNode;
    /**
     * Whether a headline is still coming, and so whether the loading placeholder is drawn.
     *
     * It has to be said rather than inferred, because the Tiles that *do* headline a count pass no
     * `headline` while they are loading — that is the whole state the placeholder exists for. Defaults
     * to "a headline was handed in", which keeps a Tile that already has its number honest; the money
     * Tiles pass neither, and so show no grey block that appears and vanishes.
     */
    readonly expectsHeadline?: boolean;
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

/**
 * Secondary text that can actually be read.
 *
 * **Not** `theme.colors.text.secondaryColor`, which every Tile reached for first and which is
 * `rgb(226, 230, 233)` — a contrast ratio of about **1.25:1** against the Tile's white background,
 * where WCAG AA asks 4.5:1 for body text. Measured in the browser, not guessed: the dates and the
 * account routes on the Transactions Tile were very nearly invisible, and so was every Tile's
 * `as of 14:32` footer. That token is a divider colour wearing a text colour's name.
 *
 * Opacity rather than a second colour, deliberately. It blends toward whatever is actually behind
 * the text, so the same rule holds in a dark theme without a second definition to keep in step —
 * which is the failure mode a hard-coded grey would have. At 0.72 over white this lands near
 * `#6c6c6c`, about **5.3:1**, so it keeps the hierarchy that made `secondaryColor` tempting while
 * being legible to someone who is not looking for it.
 */
export const mutedText = css`
    color: ${({ theme }) => theme.colors.text.color};
    opacity: 0.72;
`;

const Footer = styled.div`
    ${mutedText}
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

/**
 * The control. No minimum height, so it sits short at the top of a stretched grid cell rather than
 * filling it, and the secondary background is what makes it read as grey in both themes without a
 * per-Tile colour decision — the same reason the frame's border is a theme token.
 */
const ButtonFrame = styled(Frame)`
    min-height: 0;
    background: ${({ theme }) => theme.colors.background.secondaryBackground};
`;

const ButtonInside = styled(Heading)`
    justify-content: space-between;
    padding: 0.75rem 1rem;
    color: ${({ theme }) => theme.colors.text.color};
    font-weight: 600;
`;

export function DashboardTile({
    role,
    icon,
    title,
    state,
    variant = "tile",
    headline,
    expectsHeadline,
    body,
    footer,
    onOpen,
    href
}: DashboardTileProps) {
    const inside =
        variant === "button" ? (
            <ButtonInside>
                <span>
                    <span aria-hidden>{icon}</span> {title}
                </span>
                <span aria-hidden>↗</span>
            </ButtonInside>
        ) : (
            <Inside>
                <Heading>
                    <span aria-hidden>{icon}</span>
                    <span>{title}</span>
                </Heading>

                {state === "loading" && (expectsHeadline ?? headline !== undefined) && (
                    <Placeholder data-role={`${role}-headline-placeholder`}>—</Placeholder>
                )}
                {state === "error" && <Sorry data-role={`${role}-error`}>could not read this</Sorry>}

                {state === "ready" && headline !== undefined && (
                    <Headline data-role={`${role}-headline`}>{headline}</Headline>
                )}
                {state === "ready" && body !== undefined && <Body data-role={`${role}-body`}>{body}</Body>}
                {state === "ready" && footer !== undefined && <Footer data-role={`${role}-footer`}>{footer}</Footer>}
            </Inside>
        );

    const Outside = variant === "button" ? ButtonFrame : Frame;

    return (
        <Outside data-role={role} data-state={state} data-variant={variant}>
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
        </Outside>
    );
}
