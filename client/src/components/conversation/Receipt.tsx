import { useState } from "react";
import styled from "styled-components";

import type { Receipt as ReceiptItem } from "./entries";
import { ICONS } from "./icons";

/**
 * A `tool-intent` and its `tool-result`, as one Bubble.
 *
 * One act, one Bubble, closed by default: the arguments and the result are what a reader wants when
 * something looks wrong, and noise the rest of the time. An intent with no result is the one case a
 * Receipt stands open-ended — the call is still in flight, or it died — and it says so rather than
 * looking like a call that returned nothing.
 */

const Row = styled.div`
    display: flex;
    justify-content: flex-start;
    margin: 0.35rem 0;
`;

const Body = styled.div`
    max-width: 80%;
    border: 1px solid ${({ theme }) => theme.colors.divider.colorSubtle};
    border-radius: 0.5rem;
    background: ${({ theme }) => theme.colors.background.nonInteractiveBackground};
    color: ${({ theme }) => theme.colors.text.color};
`;

const Toggle = styled.button`
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    width: 100%;
    padding: 0.4rem 0.75rem;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
`;

const Operation = styled.span`
    font-family: monospace;
`;

const Aside = styled.span`
    color: ${({ theme }) => theme.colors.text.secondaryColor};
    font-size: 0.8em;
`;

const Detail = styled.div`
    padding: 0 0.75rem 0.5rem;
    border-top: 1px solid ${({ theme }) => theme.colors.divider.colorSubtle};
`;

const Caption = styled.div`
    margin-top: 0.4rem;
    color: ${({ theme }) => theme.colors.text.secondaryColor};
    font-size: 0.75em;
`;

const Code = styled.pre`
    margin: 0.15rem 0 0;
    overflow-x: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 0.8em;
`;

export interface ReceiptProps {
    readonly receipt: ReceiptItem;
}

export function Receipt({ receipt }: ReceiptProps) {
    const [open, setOpen] = useState(false);
    const { intent, result } = receipt;
    const operation = intent?.toolName ?? result?.toolName ?? "";

    return (
        <Row data-testid="transcript-receipt" data-open={open}>
            <Body>
                <Toggle
                    type="button"
                    aria-expanded={open}
                    data-testid="transcript-receipt-toggle"
                    onClick={() => setOpen((was) => !was)}>
                    <span aria-hidden>{ICONS.tool}</span>
                    <Operation>{operation}</Operation>
                    {intent?.text !== undefined && intent.text !== "" && <Aside>{intent.text}</Aside>}
                    {result === undefined && <Aside>no result</Aside>}
                </Toggle>
                {open && (
                    <Detail data-testid="transcript-receipt-body">
                        <Caption>arguments</Caption>
                        <Code>{intent?.toolArgs ?? "—"}</Code>
                        <Caption>result</Caption>
                        <Code>{result?.toolResult ?? "—"}</Code>
                    </Detail>
                )}
            </Body>
        </Row>
    );
}
