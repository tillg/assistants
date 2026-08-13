import { Fragment, useMemo } from "react";
import styled from "styled-components";

import { Bubble } from "./Bubble";
import { PendingQuestion } from "./PendingQuestion";
import { Receipt } from "./Receipt";
import { TranscriptHeader, readConversation } from "./TranscriptHeader";
import { clusterEntries, readEntries } from "./entries";

/**
 * A Conversation's Entries read as a dialogue.
 *
 * The box is bounded and scrolls internally, and that is not cosmetic: `position: sticky` needs a scroll
 * ancestor, and if the only one were the form engine's own container the Header would stick to the form
 * and drift off screen with the page. Owning the box is what makes the Header pinnable — and it also
 * keeps a hundred-Entry thread from stretching the form to ten screens. The height comes from the model
 * element, so it is changeable without a rebuild.
 *
 * It reads the document the form engine already holds, and holds nothing itself.
 */

/** Exported because the question form's degraded state is the same box with nothing in it. */
export const TranscriptBox = styled.section<{ $height?: number }>`
    display: flex;
    flex-direction: column;
    height: ${({ $height }) => ($height === undefined ? "32rem" : `${$height}px`)};
    overflow-y: auto;
    border: 1px solid ${({ theme }) => theme.colors.divider.color};
    border-radius: 0.25rem;
    background: ${({ theme }) => theme.colors.background.primaryBackground};
`;

const Thread = styled.div`
    padding: 0.5rem 0.75rem 1rem;
`;

const Separator = styled.div`
    margin: 0.75rem 0 0.25rem;
    color: ${({ theme }) => theme.colors.text.secondaryColor};
    font-size: 0.75em;
    text-align: center;
`;

export interface ConversationTranscriptProps {
    /** The Conversation, as the form engine's `state.data.document` holds it. */
    readonly document: unknown;
    /** The modelled height of the box, in pixels. */
    readonly height?: number;
    /**
     * Whether a pending question ends the thread. It does on the Conversation form, and it does not on
     * the Answer Surface, where the answer controls beneath the Transcript *are* that Bubble.
     */
    readonly showPendingQuestion?: boolean;
}

export function ConversationTranscript({ document, height, showPendingQuestion = true }: ConversationTranscriptProps) {
    const entries = useMemo(() => readEntries(document), [document]);
    const clusters = useMemo(() => clusterEntries(entries), [entries]);
    const { currentQuestionId } = readConversation(document);
    const pending = showPendingQuestion && currentQuestionId !== "";

    return (
        <TranscriptBox $height={height} data-testid="conversation-transcript">
            <TranscriptHeader document={document} entries={entries} />
            <Thread>
                {clusters.map((cluster) => (
                    <Fragment key={cluster.separator + String(cluster.items.length)}>
                        <Separator data-testid="transcript-separator">{cluster.separator}</Separator>
                        {cluster.items.map((item) =>
                            item.type === "receipt" ? (
                                <Receipt
                                    key={`receipt-${item.intent?.seq ?? "?"}-${item.result?.seq ?? "?"}`}
                                    receipt={item}
                                />
                            ) : (
                                <Bubble key={`entry-${item.entry.seq}`} entry={item.entry} />
                            )
                        )}
                    </Fragment>
                ))}
                {pending && <PendingQuestion questionId={currentQuestionId} />}
            </Thread>
        </TranscriptBox>
    );
}
