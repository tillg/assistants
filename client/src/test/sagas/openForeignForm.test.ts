import { describe, expect, it } from "vitest";

import { ActivityActions } from "@com.mgmtp.a12.client/client-core";

import { openForeignForm, openForeignFormWorker } from "../../sagas/openForeignForm";

const REQUEST = openForeignForm({
    module: "OpenQuestion",
    documentModel: "OpenQuestion_DM",
    thingId: "45e95914-0000-4000-8000-000000000001",
    masterModule: "Conversation"
});

interface Answers {
    /** What `topLevelActivities()` finds — the activities the jump has to tear down. */
    readonly activities: Record<string, object>;
    /** What the cancel handshake answered. `false` is the User vetoing it. */
    readonly cancelled?: boolean;
}

/**
 * Drives the worker without a store, answering each effect by its kind. `typed-redux-saga`'s `yield*`
 * delegates to a generator that yields the plain effect, so every `next` returns the next effect and
 * its argument is what that effect resolved to.
 */
function drive({ activities, cancelled = true }: Answers, action = REQUEST): unknown[] {
    const saga = openForeignFormWorker(action);
    const dispatched: unknown[] = [];
    let step = saga.next();
    while (!step.done) {
        const effect = step.value as { type: string; payload?: { action?: unknown } };
        if (effect.type === "PUT" && effect.payload?.action !== undefined) {
            dispatched.push(effect.payload.action);
        }
        step = saga.next(effect.type === "SELECT" ? activities : effect.type === "CALL" ? cancelled : undefined);
    }
    return dispatched;
}

/** The `PUSH` action `ActivityActions.create` builds carries the whole activity. */
function descriptorOf(action: unknown) {
    return (action as ReturnType<typeof ActivityActions.create>).payload.activity.descriptor;
}

function parentOf(action: unknown) {
    return (action as ReturnType<typeof ActivityActions.create>).payload.activity.initiatingActivityId;
}

describe("openForeignFormWorker", () => {
    it("cancels what is open, then pushes the master and the detail", () => {
        const dispatched = drive({ activities: { "activity-1": {} } });

        expect(dispatched).toHaveLength(3);
        expect((dispatched[0] as { payload: { activityIds: string[] } }).payload.activityIds).toEqual(["activity-1"]);
        expect(descriptorOf(dispatched[1])).toEqual({ module: "Conversation" });
    });

    it("composes a docRef out of the bare ThingID, and always names the model", () => {
        const dispatched = drive({ activities: { "activity-1": {} } });

        expect(descriptorOf(dispatched[2])).toEqual({
            module: "OpenQuestion",
            instance: "OpenQuestion_DM/45e95914-0000-4000-8000-000000000001",
            model: "OpenQuestion_DM"
        });
    });

    it("parents the detail on the master it just pushed, so Cancel has somewhere to go", () => {
        const dispatched = drive({ activities: { "activity-1": {} } });

        const masterId = (dispatched[1] as ReturnType<typeof ActivityActions.create>).payload.activity.id;
        expect(parentOf(dispatched[2])).toBe(masterId);
    });

    it("honours the master module the caller asked for", () => {
        const dispatched = drive(
            { activities: { "activity-1": {} } },
            openForeignForm({
                module: "Invoice",
                documentModel: "Invoice_DM",
                thingId: "a3f9c1de",
                masterModule: "Invoice"
            })
        );

        expect(descriptorOf(dispatched[1])).toEqual({ module: "Invoice" });
        expect(descriptorOf(dispatched[2])).toEqual({
            module: "Invoice",
            instance: "Invoice_DM/a3f9c1de",
            model: "Invoice_DM"
        });
    });

    it("pushes nothing at all when the User vetoes the cancel", () => {
        const dispatched = drive({ activities: { "activity-1": {} }, cancelled: false });

        expect(dispatched).toHaveLength(1);
    });

    it("skips the cancel when there is nothing open to cancel", () => {
        const dispatched = drive({ activities: {} });

        expect(dispatched).toHaveLength(2);
        expect(descriptorOf(dispatched[0])).toEqual({ module: "Conversation" });
    });
});
