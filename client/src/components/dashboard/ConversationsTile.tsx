import { useDispatch } from "react-redux";

import { openModule } from "../../sagas/openModule";

import { PLACE_ICONS } from "../icons";

import { DashboardTile } from "./DashboardTile";
import { asOf } from "./readAt";
import { useThingCounts, type CountQuery } from "./useThingCounts";

/**
 * How much work is **In flight**: a Conversation whose `status` is `running` or `waiting`. That sum is
 * the headline because *"running conversations"* is the question a User asks and `status = "running"` is
 * not the answer to it — that state lasts a Turn, seconds at a time, while a `waiting` Conversation is
 * where the days go.
 *
 * Three counts, one round trip. The values are **codes, not display text**: `Status` and `WaitingFor`
 * are `StringType`s carrying ASCII precisely so that `exact_match` works in both locales.
 */

const field = (name: string) => `/Conversation/${name}`;

const QUERIES: readonly CountQuery[] = [
    {
        key: "running",
        model: "Conversation_DM",
        constraint: { operator: "exact_match", field: field("Status"), value: "running" }
    },
    {
        key: "waitingOnUser",
        model: "Conversation_DM",
        constraint: {
            operator: "and",
            operands: [
                { operator: "exact_match", field: field("Status"), value: "waiting" },
                { operator: "exact_match", field: field("WaitingFor"), value: "user" }
            ]
        }
    },
    {
        // `not(exact_match(…))` rather than an enumeration of the other values, so a `waitingFor` the
        // Runtime learns to write is counted rather than silently dropped from the headline.
        key: "waitingOnOther",
        model: "Conversation_DM",
        constraint: {
            operator: "and",
            operands: [
                { operator: "exact_match", field: field("Status"), value: "waiting" },
                { operator: "not", operand: { operator: "exact_match", field: field("WaitingFor"), value: "user" } }
            ]
        }
    }
];

export function ConversationsTile() {
    const dispatch = useDispatch();
    const counts = useThingCounts(QUERIES);

    const inFlight =
        counts.state === "ready"
            ? counts.counts["running"]! + counts.counts["waitingOnUser"]! + counts.counts["waitingOnOther"]!
            : undefined;

    return (
        <DashboardTile
            role="tile-conversations"
            icon={PLACE_ICONS.conversations}
            title="Conversations"
            state={counts.state}
            expectsHeadline
            headline={inFlight === undefined ? undefined : `${inFlight} in flight`}
            body={
                counts.state === "ready" ? (
                    <>
                        <span data-role="tile-conversations-running">{counts.counts["running"]} running</span>
                        <span data-role="tile-conversations-waiting-on-you">
                            {counts.counts["waitingOnUser"]} waiting on you
                        </span>
                        <span data-role="tile-conversations-waiting">{counts.counts["waitingOnOther"]} waiting</span>
                    </>
                ) : undefined
            }
            footer={counts.state === "ready" ? asOf(counts.readAt) : undefined}
            onOpen={() => dispatch(openModule({ module: "Conversation" }))}
        />
    );
}
