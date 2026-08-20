import { useDispatch } from "react-redux";
import styled from "styled-components";

import { openForeignForm } from "../../sagas/openForeignForm";

import { MarkdownRichTextEditor } from "../markdown-editor";
import { ICONS } from "../icons";

import { transcriptStrings } from "./localize";
import { readOpenQuestion } from "./question";
import { useThingById } from "./useThingById";

/**
 * The Bubble a blocked Conversation ends in: what the Assistant is waiting to be told, and the one step
 * that answers it.
 *
 * The words are not on the Conversation at all. An `approval-request` Entry has no text — it says that a
 * question was asked and nothing about what it asked — so this Bubble reads the Open Question itself, by
 * id, through `useThingById`. That read is the whole reason this change exists.
 *
 * The prompt renders through the read-only Markdown editor because a prompt is the one string in a
 * thread that was *authored* as markdown, by `advance.ts` and by the approval writer, both of which open
 * with a bold heading. One editor, on one string, rather than one per Bubble.
 *
 * **Answer** dispatches and knows nothing else: `openForeignForm` owns the teardown, the master and the
 * docRef composition. The master it asks for is `Conversation`, because the User came from Conversations
 * and answering is a step inside that act — landing them on a list of questions would rebuild the second
 * inbox this change exists to remove.
 */

const Row = styled.div`
    display: flex;
    justify-content: flex-start;
    margin: 0.35rem 0;
`;

const Body = styled.div`
    display: flex;
    gap: 0.5rem;
    align-items: flex-start;
    max-width: 80%;
    padding: 0.5rem 0.75rem;
    border: 1px solid ${({ theme }) => theme.colors.variant.warningColor};
    border-radius: 0.5rem;
    background: ${({ theme }) => theme.colors.variant.warningColorLight};
    color: ${({ theme }) => theme.colors.text.color};
`;

const Icon = styled.span`
    line-height: 1.4;
`;

const Options = styled.ul`
    margin: 0.25rem 0 0;
    padding-left: 1.25rem;
    font-size: ${({ theme }) => theme.typography.fontSize.smallFontSize};
`;

const Answer = styled.button`
    margin-top: 0.5rem;
    padding: 0.25rem 0.75rem;
    border: 1px solid ${({ theme }) => theme.colors.interaction.primaryInteractionColor};
    border-radius: 0.25rem;
    background: ${({ theme }) => theme.colors.interaction.primaryInteractionColor};
    color: ${({ theme }) => theme.colors.text.invertedColor};
    font: inherit;
    cursor: pointer;
`;

/**
 * The line that stands where something the screen could not read would have been. A plain element, not
 * the Typography widget: its `data-role` is the test and selector handle, and the widget stamps its own
 * `data-role` over any it is given.
 */
export const Message = styled.div`
    margin: 0.35rem 0;
    color: ${({ theme }) => theme.colors.text.secondaryColor};
    font-size: ${({ theme }) => theme.typography.fontSize.smallFontSize};
    font-style: italic;
    text-align: center;
`;

export interface PendingQuestionProps {
    /** A bare ThingID, straight off the Conversation's `CurrentQuestionId`. */
    readonly questionId: string;
}

export function PendingQuestion({ questionId }: PendingQuestionProps) {
    const dispatch = useDispatch();
    const read = useThingById("OpenQuestion_DM", questionId);

    if (read.state === "loading") {
        return null;
    }
    if (read.state === "nothing") {
        // The Conversation says it is blocked and the question is gone: say so, and leave the thread
        // above it standing. A missing second document is never a reason for a form not to open.
        return (
            <Message data-role="transcript-message">
                <span aria-hidden>{`${ICONS.blocked} `}</span>A question is pending, but it could not be read.
            </Message>
        );
    }

    const question = readOpenQuestion(read.document);

    return (
        <Row data-role="pending-question">
            <Body>
                <Icon aria-hidden>{ICONS.blocked}</Icon>
                <div>
                    <MarkdownRichTextEditor
                        id={`pending-question-${questionId}`}
                        label="Question"
                        hideLabel
                        readonly
                        value={question.prompt}
                        onMarkdownChange={noop}
                    />
                    {question.options.length > 0 && (
                        <Options data-role="pending-question-options">
                            {question.options.map((option) => (
                                <li key={option.value}>{option.label}</li>
                            ))}
                        </Options>
                    )}
                    <Answer
                        type="button"
                        data-role="pending-question-answer"
                        onClick={() =>
                            dispatch(
                                openForeignForm({
                                    module: "OpenQuestion",
                                    documentModel: "OpenQuestion_DM",
                                    thingId: questionId,
                                    masterModule: "Conversation"
                                })
                            )
                        }>
                        {transcriptStrings().answer}
                    </Answer>
                </div>
            </Body>
        </Row>
    );
}

/** The editor is read-only, so nothing ever changes; it still wants a handler. */
function noop(): void {}
