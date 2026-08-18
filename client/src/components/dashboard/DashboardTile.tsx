import type { ReactNode } from "react";
import styled, { css } from "styled-components";

import { Card, Typography } from "@com.mgmtp.a12.widgets/widgets-core";

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
 *
 * **Sizes come from the theme, and never from an `em`.** Every rule here was once a fraction — `0.9em` on
 * the body, `0.8em` on the footer — and `em` compounds: a `0.9em` row inside a `0.9em` body renders at
 * `0.81em`, so the Tiles bottomed out around 12px while every stylesheet involved looked innocent. The
 * rules below therefore name a **token** (`theme.typography.fontSize.*`, absolute `rem`) or name nothing
 * at all, and the floor across the Dashboard is `smallFontSize`, 14px.
 *
 * **`Typography.Headline` draws both headings**, so the title's and the big number's size, weight and
 * near-black headline colour are the platform's rather than three hand-set rules kept in step by hand.
 * It is the only widget used here: `Typography.Body` writes its own `data-role` onto the element *after*
 * the props it was handed, so anything it wrapped would lose the attribute the tests and the e2e page
 * object find it by — and it contributes nothing else a token does not. The two headings survive that
 * because a heading needs no `data-role`, or (for the number) can carry it on a wrapper.
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

/**
 * Both headings on a Tile: the title at `level={2}`, the big number at `level={1}`.
 *
 * Level 2 rather than the levels that sound like a card title — this theme sizes `headline3` at 14px,
 * `headline4` at 12px *and uppercases it*, and `headline5` at 14.4px, all of them **smaller** than the
 * 16px the title already was, which is the wrong direction for a Dashboard that was reported as reading
 * too small. `headline2` is 18px semi-bold; `headline1` is 2rem, exactly the size the hand-set rule it
 * replaces was asking for.
 *
 * The margin is the one thing overridden. A12's headlines carry the margins of a heading that separates
 * sections of a *form* — 24px above the title, 12px below it — which inside a 1rem-padded Tile is a gap
 * above the icon and a doubled gap below it, on top of the column's own `gap`. `&&` because the widget's
 * rule and ours are both a single class, and equal specificity would leave stylesheet insertion order to
 * decide it.
 */
const Headline = styled(Typography.Headline)`
    && {
        margin: 0;
    }
`;

/**
 * The same height the headline occupies, so a Tile does not jump when its number arrives.
 *
 * The grey block is the headline *inside* this wrapper rather than the wrapper itself: it has to be the
 * widget's own size — 2rem, so `3ch` is three of the digits that are coming — and the widget sets its own
 * colour, which would leave the em dash legibly dark on the grey without a rule reaching in to hide it.
 */
const Placeholder = styled.div`
    & > * {
        width: 3ch;
        border-radius: 0.2rem;
        background: ${({ theme }) => theme.colors.divider.color};
        color: transparent;
    }
`;

const Body = styled.div`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 0.2rem;
    /* Named, not inherited: a Tile's body is the platform's body size wherever this chrome is mounted. */
    font-size: ${({ theme }) => theme.typography.fontSize.mediumFontSize};
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

/**
 * `smallFontSize` — 14px, the smallest the theme offers for text meant to be read, and the floor for
 * anything on a Tile. Quieter than the body it follows, which is the hierarchy the old `0.8em` was after
 * before compounding took it down to about 13px.
 */
const Footer = styled.div`
    ${mutedText}
    font-size: ${({ theme }) => theme.typography.fontSize.smallFontSize};
`;

/** The one line a Tile has when it has nothing else: body size, so it is not the quietest thing on it. */
const Sorry = styled.div`
    color: ${({ theme }) => theme.colors.variant.text.warning};
    font-size: ${({ theme }) => theme.typography.fontSize.mediumFontSize};
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

/**
 * A label, not a heading — so no `Typography.Headline`: a control announcing itself as a heading is a
 * lie to a screen reader's landmark list, and the widget's inner title element is a flex row of its own
 * that the `↗` would have to be fought into the far end of. Body size at 600, which is where it already
 * was; the compounding `em`s were never here.
 */
const ButtonInside = styled.div`
    display: flex;
    gap: 0.5rem;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    color: ${({ theme }) => theme.colors.text.color};
    font-size: ${({ theme }) => theme.typography.fontSize.mediumFontSize};
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
                <Headline level={2}>
                    <span aria-hidden>{icon}</span> <span>{title}</span>
                </Headline>

                {state === "loading" && (expectsHeadline ?? headline !== undefined) && (
                    <Placeholder data-role={`${role}-headline-placeholder`}>
                        <Headline level={1}>—</Headline>
                    </Placeholder>
                )}
                {state === "error" && <Sorry data-role={`${role}-error`}>could not read this</Sorry>}

                {/*
                 * The `data-role` sits on a wrapper because `Typography.Headline` writes its own last and
                 * would swallow one handed in — and this attribute is how the spec finds the number.
                 */}
                {state === "ready" && headline !== undefined && (
                    <div data-role={`${role}-headline`}>
                        <Headline level={1}>{headline}</Headline>
                    </div>
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
