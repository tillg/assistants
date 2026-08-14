import { afterEach, describe, expect, it, vi } from "vitest";

import { ActivityActions } from "@com.mgmtp.a12.client/client-core";
import { LoggerFactory } from "@com.mgmtp.a12.utils/utils-logging";

import {
    OPEN_FOREIGN_FORM,
    OpenForeignFormSaga,
    openForeignForm,
    openForeignFormWorker
} from "../../sagas/openForeignForm";

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

    it("swallows a jump that failed, because every jump after it still has to work", () => {
        const warn = vi.spyOn(LoggerFactory.getLogger("PT/openForeignForm"), "warn").mockImplementation(() => {});
        const saga = openForeignFormWorker(REQUEST);
        saga.next();

        // `takeEvery` forks the worker, and an error escaping a fork ends the parent that forked it. Let
        // this one out and the saga is gone for the session: every later Answer, *about* and *called by*
        // becomes a click that does nothing, with nothing on screen to say why.
        expect(saga.throw(new Error("the activity map is gone")).done).toBe(true);
        expect(warn).toHaveBeenCalledOnce();
    });
});

/** The `takeEvery` the saga installs, as redux-saga frames it: a pattern, and the worker it forks. */
function wiring(): { readonly matches: (action: unknown) => boolean; readonly worker: unknown } {
    const effect = OpenForeignFormSaga().next().value as {
        payload: { args: [(action: unknown) => boolean, unknown] };
    };
    return { matches: effect.payload.args[0], worker: effect.payload.args[1] };
}

/** The wiring itself, which every test above skips by driving the worker directly. */
describe("OpenForeignFormSaga", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("forks the worker for its own action", () => {
        const { matches, worker } = wiring();

        expect(matches(REQUEST)).toBe(true);
        expect(worker).toBe(openForeignFormWorker);
    });

    it("ignores everything else, including what is not an action at all", () => {
        const { matches } = wiring();

        // The predicate reads `.type` off whatever the store dispatched, and a store carries actions
        // from the whole platform — so the non-objects have to be answered, not assumed away.
        expect(matches({ type: "a12/somethingElse" })).toBe(false);
        expect(matches({ type: `${OPEN_FOREIGN_FORM}/suffixed` })).toBe(false);
        expect(matches(undefined)).toBe(false);
        expect(matches(null)).toBe(false);
        expect(matches("a string")).toBe(false);
    });
});
