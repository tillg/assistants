import { useState } from "react";
import styled from "styled-components";

import { Typography } from "@com.mgmtp.a12.widgets/widgets-core";

import { iconFor } from "../icons";

import type { TranscriptEntry } from "./entries";
import { speakerFor, type Shape, type Side } from "./speaker";

/**
 * One Entry, rendered as itself.
 *
 * Its Speaker decides its side, its colour and its icon; its Kind decides its shape. Both come from
 * `speaker.ts`, which is functional.md's Speaker table as code — nothing here re-derives who said something, and in
 * particular nothing reads `role`: `prompt` and `answer` are both `role: user` and only one of them is
 * the human.
 *
 * A Speaker the table marks `collapsed` shows its label and nothing else until it is asked for. That is
 * the `system` prompt and the Runtime's briefing: each is a page of text read once, and left expanded
 * either of them buries the dialogue it introduces. The disclosure is the Receipt's, in meta clothing —
 * a thread has one way of putting something away, not two.
 *
 * Text renders as pre-wrapped plain text. Entry prose is written by a model, not authored as markdown,
 * and mounting a Lexical editor per Bubble to read a thread of a hundred would cost far more than the
 * bold headings it would buy.
 */

const JUSTIFY: Readonly<Record<Side, string>> = {
    left: "flex-start",
    right: "flex-end",
    centre: "center"
};

const Row = styled.div<{ $side: Side }>`
    display: flex;
    justify-content: ${({ $side }) => JUSTIFY[$side]};
    margin: 0.35rem 0;
`;

const Body = styled.div<{ $shape: Shape; $side: Side; $warning: boolean }>`
    display: flex;
    gap: 0.5rem;
    align-items: flex-start;
    max-width: ${({ $shape }) => ($shape === "meta" ? "100%" : "80%")};
    padding: ${({ $shape }) => ($shape === "meta" ? "0.1rem 0.5rem" : "0.5rem 0.75rem")};
    border-radius: 0.5rem;
    border: 1px solid
        ${({ theme, $side, $warning }) =>
            $warning
                ? theme.colors.variant.warningColor
                : $side === "right"
                  ? theme.colors.interaction.selected.color
                  : theme.colors.divider.colorSubtle};
    background: ${({ theme, $shape, $side, $warning }) =>
        $warning
            ? theme.colors.variant.warningColorLight
            : $shape === "meta"
              ? "transparent"
              : $side === "right"
                ? theme.colors.interaction.selected.colorLight
                : theme.colors.background.groupBackground};
    color: ${({ theme, $shape }) => ($shape === "meta" ? theme.colors.text.secondaryColor : theme.colors.text.color)};
    font-size: ${({ theme, $shape }) =>
        $shape === "meta" ? theme.typography.fontSize.smallFontSize : theme.typography.fontSize.mediumFontSize};
`;

const Icon = styled.span`
    line-height: 1.4;
`;

/** The entry's prose, as A12 body text; colour and size are inherited from the Bubble's shape above. */
const Text = styled(Typography.Body)`
    margin: 0;
    color: inherit;
    font-size: inherit;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
`;

const Label = styled.span`
    font-style: italic;
`;

/** A collapsed meta line is its own control: the label is what one clicks, so it carries no chrome. */
const Disclosure = styled.button`
    padding: 0;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
`;

// A metadata line, not prose: kept a plain element because the transcript's `data-role` contract is its
// test and selector handle, and the Typography widget stamps its own `data-role` over any it is given.
const Footnote = styled.div`
    margin: 0.25rem 0 0;
    font-size: ${({ theme }) => theme.typography.fontSize.tinyFontSize};
    color: ${({ theme }) => theme.colors.text.secondaryColor};
`;

export interface BubbleProps {
    readonly entry: TranscriptEntry;
}

export function Bubble({ entry }: BubbleProps) {
    const [open, setOpen] = useState(false);
    const role = speakerFor(entry.kind, entry.toolName);
    const icon = iconFor(role.speaker);
    const recorded = (entry.promptTokens ?? 0) + (entry.completionTokens ?? 0);
    const text = entry.text !== undefined && entry.text !== "" ? entry.text : undefined;
    // Nothing to put away is nothing to disclose: an `approval-request` carries no text by design, and a
    // label with a toggle behind it that reveals an empty box would be a control that does nothing.
    const collapsible = role.collapsed && text !== undefined;

    return (
        <Row
            $side={role.side}
            data-role="transcript-bubble"
            data-seq={entry.seq}
            data-kind={entry.kind}
            data-side={role.side}
            data-speaker={role.speaker}
            data-collapsed={collapsible && !open}>
            <Body $shape={role.shape} $side={role.side} $warning={role.warning}>
                {icon !== undefined && <Icon aria-hidden>{icon}</Icon>}
                <div>
                    {collapsible && (
                        <Disclosure
                            type="button"
                            aria-expanded={open}
                            data-role="transcript-bubble-toggle"
                            onClick={() => setOpen((was) => !was)}>
                            <Label>{role.label}</Label>
                        </Disclosure>
                    )}
                    {!collapsible && role.label !== undefined && <Label>{role.label}</Label>}
                    {text !== undefined && (open || !collapsible) && <Text>{text}</Text>}
                    {recorded > 0 && (open || !collapsible) && (
                        <Footnote data-role="transcript-cost-footnote">
                            {`${format(entry.promptTokens ?? 0)} + ${format(entry.completionTokens ?? 0)} tokens`}
                        </Footnote>
                    )}
                </div>
            </Body>
        </Row>
    );
}

function format(count: number): string {
    return new Intl.NumberFormat().format(count);
}
