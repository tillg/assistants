import styled from "styled-components";

import { ConversationTranscript, TranscriptBox } from "./ConversationTranscript";
import { Band, Who } from "./TranscriptHeader";
import { ICONS } from "./icons";
import { Message } from "./PendingQuestion";
import { readOpenQuestion } from "./question";
import { useThingById } from "./useThingById";

/**
 * The Answer Surface's half of seam 4: the Conversation a question came out of, read by the id the
 * question carries, and rendered as the same thread the User was just looking at. The second screen has
 * to read as the first one continuing, which is why it is the same component and not a second view.
 *
 * It shows **no** Pending Question Bubble. The answer controls the form models beneath this element are
 * that bubble, and two of them would be two ways to answer one question.
 *
 * The degraded state is the case that matters. Everywhere else a failed read costs an addition to a
 * screen; here the fetched Conversation *is* the screen's context, and the *Details* section that used
 * to carry `assistantKey` and `conversationId` is now collapsed. So the Header falls back to the
 * OpenQuestion's own document — its Assistant, its kind, the id it could not follow — beside one message
 * line, and the prompt and the answer controls, which are siblings of this element and not children of
 * it, are untouched. The screen stays answerable, which is the only thing that must never break.
 */

const Body = styled.div`
    padding: 0.5rem 0.75rem 1rem;
`;

const Kind = styled.span`
    font-weight: 400;
    color: ${({ theme }) => theme.colors.text.secondaryColor};
`;

export interface QuestionContextProps {
    /** The OpenQuestion, as the form engine's `state.data.document` holds it. */
    readonly document: unknown;
    /** The modelled height of the box, in pixels. */
    readonly height?: number;
}

export function QuestionContext({ document, height }: QuestionContextProps) {
    const question = readOpenQuestion(document);
    const read = useThingById("Conversation_DM", question.conversationId);

    if (read.state === "ready") {
        return <ConversationTranscript document={read.document} height={height} showPendingQuestion={false} />;
    }
    if (read.state === "loading") {
        return null;
    }

    return (
        <TranscriptBox $height={height} data-role="conversation-transcript">
            <Band data-role="transcript-header">
                <Who data-role="transcript-who">
                    <span aria-hidden>{ICONS.assistant}</span>
                    <span>{question.assistantKey}</span>
                    <Kind>{question.kind}</Kind>
                </Who>
            </Band>
            <Body>
                <Message data-role="transcript-message">
                    {question.conversationId === ""
                        ? "This question names no conversation, so there is no thread to show."
                        : `This question's conversation (${question.conversationId}) could not be read.`}
                </Message>
            </Body>
        </TranscriptBox>
    );
}
