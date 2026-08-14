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

/**
 * Exported because the question form's degraded state is the same box with nothing in it.
 *
 * It is focusable, and that is a consequence of owning the scroll rather than a decoration: the thread
 * holds no focusable element between its Bubbles, so without a tab stop of its own a reader who does not
 * use a mouse can never reach the scrollbar and can only ever see the first screenful (WCAG 2.1.1). The
 * name is what makes a `<section>` a region, and so a stop worth landing on rather than an unlabelled
 * one.
 */
export const TranscriptBox = styled.section.attrs({ tabIndex: 0, "aria-label": "Conversation transcript" })<{
    $height?: number;
}>`
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
        <TranscriptBox $height={height} data-role="conversation-transcript">
            <TranscriptHeader document={document} entries={entries} />
            <Thread>
                {/*
                 * Keyed by position rather than by `seq` or by the separator's words, because neither is
                 * unique: an Entry whose document carried no `Seq` reads as 0, and an instant nothing can
                 * parse labels its cluster with the empty string. Two of either collide, and a colliding
                 * key is not a cosmetic warning here — a Receipt holds its open/closed in `useState`, so
                 * React reconciling the wrong one opens the wrong Receipt. Position is unique by
                 * construction, and stable for everything already on screen: Entries are only ever
                 * appended, and a `tool-result` arriving fills the Receipt its call already opened.
                 */}
                {clusters.map((cluster, position) => (
                    <Fragment key={position}>
                        {/*
                         * Only when it has words to say. `separatorLabel` answers the empty string for
                         * an instant nothing can parse, and an empty Separator is a div with no content
                         * and therefore no height — invisible to a reader and, worse, *present* to
                         * anything looking for one. A spec asserting the thread shows separators found
                         * this: the element resolved and was `hidden`, which reads as a broken
                         * transcript rather than as a cluster that could not date itself.
                         */}
                        {cluster.separator !== "" && (
                            <Separator data-role="transcript-separator">{cluster.separator}</Separator>
                        )}
                        {cluster.items.map((item, index) =>
                            item.type === "receipt" ? (
                                <Receipt key={index} receipt={item} />
                            ) : (
                                <Bubble key={index} entry={item.entry} />
                            )
                        )}
                    </Fragment>
                ))}
                {pending && <PendingQuestion questionId={currentQuestionId} />}
            </Thread>
        </TranscriptBox>
    );
}
