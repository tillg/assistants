import styled from "styled-components";

import type { TranscriptEntry } from "./entries";
import { iconFor } from "./icons";
import { speakerFor, type Shape, type Side } from "./speaker";

/**
 * One Entry, rendered as itself.
 *
 * Its Speaker decides its side, its colour and its icon; its Kind decides its shape. Both come from
 * `speaker.ts`, which is domain.md's table as code — nothing here re-derives who said something, and in
 * particular nothing reads `role`: `prompt` and `answer` are both `role: user` and only one of them is
 * the human.
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
    font-size: ${({ $shape }) => ($shape === "meta" ? "0.8em" : "1em")};
`;

const Icon = styled.span`
    line-height: 1.4;
`;

const Text = styled.div`
    white-space: pre-wrap;
    overflow-wrap: anywhere;
`;

const Label = styled.span`
    font-style: italic;
`;

const Footnote = styled.div`
    margin-top: 0.25rem;
    font-size: 0.75em;
    color: ${({ theme }) => theme.colors.text.secondaryColor};
`;

export interface BubbleProps {
    readonly entry: TranscriptEntry;
}

export function Bubble({ entry }: BubbleProps) {
    const role = speakerFor(entry.kind, entry.toolName);
    const icon = iconFor(role.speaker);
    const recorded = (entry.promptTokens ?? 0) + (entry.completionTokens ?? 0);

    return (
        <Row
            $side={role.side}
            data-testid="transcript-bubble"
            data-seq={entry.seq}
            data-kind={entry.kind}
            data-side={role.side}
            data-speaker={role.speaker}>
            <Body $shape={role.shape} $side={role.side} $warning={role.warning}>
                {icon !== undefined && <Icon aria-hidden>{icon}</Icon>}
                <div>
                    {role.label !== undefined && <Label>{role.label}</Label>}
                    {entry.text !== undefined && entry.text !== "" && <Text>{entry.text}</Text>}
                    {recorded > 0 && (
                        <Footnote data-testid="transcript-cost-footnote">
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
