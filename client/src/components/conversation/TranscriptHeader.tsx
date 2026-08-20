import { format, isValid } from "date-fns";
import styled from "styled-components";

import { AssistantBadge } from "../AssistantBadge";
import { ThingLink } from "../ThingLink";
import { ICONS } from "../icons";

import { formatRecordedCost, recordedCost } from "./cost";
import type { TranscriptEntry } from "./entries";
import { transcriptStrings } from "./localize";
import { subjectDescriptor } from "./subject";
import { shortId } from "./thingLabel";

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

/**
 * The Conversation's own Title, leading the band on its own line: `flex-basis: 100%` takes the whole
 * width so the Assistant badge and the slots wrap beneath it. It is omitted entirely when there is no
 * Title — a freshly-born Conversation — so the band never opens on an empty bold gap.
 */
const Title = styled.div`
    flex-basis: 100%;
    font-weight: 600;
    color: ${({ theme }) => theme.colors.text.color};
`;

const Slot = styled.div`
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    /* secondaryColorDark, not secondaryColor: on this white band the latter is blue95 (~#ebf1f7), which
       renders the turn/cost metadata at ~1.3:1 — illegible. secondaryColorDark (~#616f7c, ~5:1) is the
       readable muted grey the platform's own typography uses. */
    color: ${({ theme }) => theme.colors.text.secondaryColorDark};
    font-size: ${({ theme }) => theme.typography.fontSize.smallFontSize};
`;

const Cost = styled(Slot)`
    margin-left: auto;
`;

const Blocked = styled.span`
    color: ${({ theme }) => theme.colors.variant.text.warning};
`;

export interface TranscriptHeaderProps {
    readonly document: unknown;
    readonly entries: readonly TranscriptEntry[];
}

export function TranscriptHeader({ document, entries }: TranscriptHeaderProps) {
    const head = readConversation(document);
    const subject = subjectDescriptor(head.subjectModel, head.subjectThingId);
    const t = transcriptStrings();

    return (
        <Band data-role="transcript-header">
            {head.title !== "" && <Title data-role="transcript-title">{head.title}</Title>}
            <Who data-role="transcript-who">
                <AssistantBadge assistantKey={head.assistantKey} />
            </Who>

            <Slot data-role="transcript-about">
                {subject !== undefined && (
                    // The subject Thing, named the one way the system names a Thing — title, Model in
                    // brackets, a link that opens its form read-only in place rather than navigating away.
                    // The whitelist still gates it: only a subject with a navigable Model is offered.
                    <ThingLink model={subject.model} thingId={head.subjectThingId} prefix={t.about} />
                )}
                {subject === undefined && head.subjectThingId !== "" && (
                    // A `subjectModel` with no navigable module: text, rather than a link that could not
                    // open a form (domain.md — a link that cannot open a form is not offered as one).
                    <span>{`${t.about} ${head.subjectModel} ${shortId(head.subjectThingId)}`}</span>
                )}
                {head.subjectThingId === "" && head.scheduledFor !== "" && (
                    <span>{`${t.scheduledFor} ${instantLabel(head.scheduledFor)}`}</span>
                )}
                {head.parentConversationId !== "" && (
                    <ThingLink model="Conversation_DM" thingId={head.parentConversationId} prefix={t.calledBy} />
                )}
            </Slot>

            <Slot data-role="transcript-state">
                {isBlocked(head) && (
                    <Blocked data-role="transcript-blocked">
                        {/* The glyph repeats the words beside it, so a reader who is read to hears
                            "stop sign waiting for you" unless it is hidden — as every other glyph is. */}
                        <span aria-hidden>{`${ICONS.blocked} `}</span>
                        {t.waitingForYou}
                    </Blocked>
                )}
                {head.finishReason !== "" && <span>{head.finishReason}</span>}
                <span>{`${t.turn} ${head.turnCount}/${head.maxTurns}`}</span>
            </Slot>

            <Cost data-role="transcript-cost">{`${formatRecordedCost(recordedCost(entries))} ${t.recorded}`}</Cost>
        </Band>
    );
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
