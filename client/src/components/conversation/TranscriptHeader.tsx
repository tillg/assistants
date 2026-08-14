import { format, isValid } from "date-fns";
import { useDispatch } from "react-redux";
import styled from "styled-components";

import { openForeignForm } from "../../sagas/openForeignForm";

import { formatRecordedCost, recordedCost } from "./cost";
import type { TranscriptEntry } from "./entries";
import { ICONS } from "./icons";
import { subjectDescriptor } from "./subject";

/**
 * The pinned band above a Transcript: who is talking, what it is about, where it stands, what it has
 * cost. Forty Entries down, those four facts are precisely what a reader can no longer see.
 *
 * It stores nothing and is the Authority for nothing — every field is read or derived from the
 * Conversation the form already holds. The cost is the one statement it adds, and it is stated as a
 * lower bound on purpose: a Turn that died before writing an Entry recorded nothing, so a bare total
 * would be a false claim.
 *
 * It is `position: sticky` rather than a modelled section because the form engine gives no way to pin
 * one — a sticky element needs a scroll ancestor it can stick inside, and the Transcript's own bounded
 * box is that ancestor.
 */

/** The head fields of a Conversation, in the terms the Header renders them. */
export interface ConversationHead {
    readonly assistantKey: string;
    readonly title: string;
    readonly status: string;
    readonly waitingFor: string;
    readonly finishReason: string;
    readonly turnCount: number;
    readonly maxTurns: number;
    readonly subjectModel: string;
    readonly subjectThingId: string;
    readonly scheduledFor: string;
    readonly parentConversationId: string;
    readonly currentQuestionId: string;
}

/** Reads a Conversation's own fields, by name, as `entries.ts` reads its Entries. */
export function readConversation(document: unknown): ConversationHead {
    const fields = asRecord(asRecord(document)?.["Conversation"]) ?? {};
    return {
        assistantKey: asString(fields["AssistantKey"]),
        title: asString(fields["Title"]),
        status: asString(fields["Status"]),
        waitingFor: asString(fields["WaitingFor"]),
        finishReason: asString(fields["FinishReason"]),
        turnCount: asNumber(fields["TurnCount"]),
        maxTurns: asNumber(fields["MaxTurns"]),
        subjectModel: asString(fields["SubjectModel"]),
        subjectThingId: asString(fields["SubjectThingId"]),
        scheduledFor: asString(fields["ScheduledFor"]),
        parentConversationId: asString(fields["ParentConversationId"]),
        currentQuestionId: asString(fields["CurrentQuestionId"])
    };
}

/** A Conversation waiting on the User, and nothing else (domain.md, **Blocked**). */
export function isBlocked(head: ConversationHead): boolean {
    return head.waitingFor === "user";
}

/** Exported because the question form pins the same band over the OpenQuestion's own two facts. */
export const Band = styled.header`
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1rem;
    align-items: baseline;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid ${({ theme }) => theme.colors.divider.color};
    background: ${({ theme }) => theme.colors.background.primaryBackground};
    color: ${({ theme }) => theme.colors.text.color};
`;

/** Exported with the band, for the same reason. */
export const Who = styled.div`
    display: flex;
    gap: 0.4rem;
    align-items: baseline;
    font-weight: 600;
`;

const Title = styled.span`
    font-weight: 400;
    color: ${({ theme }) => theme.colors.text.secondaryColor};
`;

const Slot = styled.div`
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    color: ${({ theme }) => theme.colors.text.secondaryColor};
    font-size: 0.85em;
`;

const Cost = styled(Slot)`
    margin-left: auto;
`;

const Link = styled.button`
    padding: 0;
    border: none;
    background: none;
    color: ${({ theme }) => theme.colors.interaction.primaryInteractionColor};
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
`;

const Blocked = styled.span`
    color: ${({ theme }) => theme.colors.variant.text.warning};
`;

export interface TranscriptHeaderProps {
    readonly document: unknown;
    readonly entries: readonly TranscriptEntry[];
}

export function TranscriptHeader({ document, entries }: TranscriptHeaderProps) {
    const dispatch = useDispatch();
    const head = readConversation(document);
    const subject = subjectDescriptor(head.subjectModel, head.subjectThingId);

    return (
        <Band data-role="transcript-header">
            <Who data-role="transcript-who">
                <span aria-hidden>{ICONS.assistant}</span>
                <span>{head.assistantKey}</span>
                <Title>{head.title}</Title>
            </Who>

            <Slot data-role="transcript-about">
                {subject !== undefined && (
                    <Link
                        type="button"
                        data-role="transcript-about-link"
                        onClick={() =>
                            dispatch(
                                openForeignForm({
                                    module: subject.module,
                                    documentModel: subject.model,
                                    thingId: head.subjectThingId,
                                    // Reading a Thing is a different act, not a step inside a
                                    // conversation, so its own list belongs beside it.
                                    masterModule: subject.module
                                })
                            )
                        }>
                        {`about ${subject.module} ${shortId(head.subjectThingId)}`}
                    </Link>
                )}
                {subject === undefined && head.subjectThingId !== "" && (
                    // A `subjectModel` with no navigable module: text, rather than a link into a scene
                    // that does not exist and would render an activity nobody can see.
                    <span>{`about ${head.subjectModel} ${shortId(head.subjectThingId)}`}</span>
                )}
                {head.subjectThingId === "" && head.scheduledFor !== "" && (
                    <span>{`scheduled for ${instantLabel(head.scheduledFor)}`}</span>
                )}
                {head.parentConversationId !== "" && (
                    <Link
                        type="button"
                        data-role="transcript-parent-link"
                        onClick={() =>
                            dispatch(
                                openForeignForm({
                                    module: "Conversation",
                                    documentModel: "Conversation_DM",
                                    thingId: head.parentConversationId,
                                    masterModule: "Conversation"
                                })
                            )
                        }>
                        {`called by ${shortId(head.parentConversationId)}`}
                    </Link>
                )}
            </Slot>

            <Slot data-role="transcript-state">
                {isBlocked(head) && (
                    <Blocked data-role="transcript-blocked">
                        {/* The glyph repeats the words beside it, so a reader who is read to hears
                            "stop sign waiting for you" unless it is hidden — as every other glyph is. */}
                        <span aria-hidden>{`${ICONS.blocked} `}</span>
                        waiting for you
                    </Blocked>
                )}
                {head.finishReason !== "" && <span>{head.finishReason}</span>}
                <span>{`turn ${head.turnCount}/${head.maxTurns}`}</span>
            </Slot>

            <Cost data-role="transcript-cost">{`${formatRecordedCost(recordedCost(entries))} recorded`}</Cost>
        </Band>
    );
}

/** Enough of a ThingID to recognise it by, which is all a header has room for. */
function shortId(thingId: string): string {
    return thingId.slice(0, 8);
}

function instantLabel(at: string): string {
    const when = new Date(at);
    return isValid(when) ? format(when, "EEE d MMM 'at' HH:mm") : at;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function asString(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
