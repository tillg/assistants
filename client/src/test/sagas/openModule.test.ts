import { afterEach, describe, expect, it, vi } from "vitest";

import { ActivityActions } from "@com.mgmtp.a12.client/client-core";
import { LoggerFactory } from "@com.mgmtp.a12.utils/utils-logging";

import { OPEN_MODULE, OpenModuleSaga, openModule, openModuleWorker } from "../../sagas/openModule";

const REQUEST = openModule({ module: "Conversation" });

interface Answers {
    /** What `topLevelActivities()` finds — the activities the jump has to tear down. */
    readonly activities: Record<string, object>;
    /** What the cancel handshake answered. `false` is the User vetoing it. */
    readonly cancelled?: boolean;
}

/**
 * Drives the worker without a store, answering each effect by its kind — the same driver
 * `openForeignForm.test.ts` uses, and for the same reason: `typed-redux-saga`'s `yield*` delegates to a
 * generator that yields the plain effect, so every `next` returns the next effect.
 */
function drive({ activities, cancelled = true }: Answers, action = REQUEST): unknown[] {
    const saga = openModuleWorker(action);
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

function descriptorOf(action: unknown) {
    return (action as ReturnType<typeof ActivityActions.create>).payload.activity.descriptor;
}

describe("openModuleWorker", () => {
    it("tears down what is open before it creates anything", () => {
        const dispatched = drive({ activities: { "activity-1": {}, "activity-2": {} } });

        expect(dispatched).toHaveLength(2);
        expect((dispatched[0] as { payload: { activityIds: string[] } }).payload.activityIds).toEqual([
            "activity-1",
            "activity-2"
        ]);
        expect(descriptorOf(dispatched[1])).toEqual({ module: "Conversation" });
    });

    it("creates nothing when the User vetoes the teardown", () => {
        const dispatched = drive({ activities: { "activity-1": {} }, cancelled: false });

        expect(dispatched).toHaveLength(1);
    });

    it("creates directly when there is nothing open", () => {
        const dispatched = drive({ activities: {} });

        expect(dispatched).toHaveLength(1);
        expect(descriptorOf(dispatched[0])).toEqual({ module: "Conversation" });
    });

    it("opens the module the Tile asked for, and no other", () => {
        const dispatched = drive({ activities: {} }, openModule({ module: "Document" }));

        expect(descriptorOf(dispatched[0])).toEqual({ module: "Document" });
    });

    it("opens a module and nothing else — no master, no detail, no instance", () => {
        const dispatched = drive({ activities: {} });

        expect(descriptorOf(dispatched[0])).not.toHaveProperty("instance");
        expect(descriptorOf(dispatched[0])).not.toHaveProperty("model");
    });

    it("swallows a jump that failed, because every Tile click after it still has to work", () => {
        const warn = vi.spyOn(LoggerFactory.getLogger("PT/openModule"), "warn").mockImplementation(() => {});
        const saga = openModuleWorker(REQUEST);
        saga.next();

        // `takeEvery` forks the worker, and an error escaping a fork ends the parent that forked it.
        expect(saga.throw(new Error("the activity map is gone")).done).toBe(true);
        expect(warn).toHaveBeenCalledOnce();
    });
});

/** The `takeEvery` the saga installs, as redux-saga frames it: a pattern, and the worker it forks. */
function wiring(): { readonly matches: (action: unknown) => boolean; readonly worker: unknown } {
    const effect = OpenModuleSaga().next().value as {
        payload: { args: [(action: unknown) => boolean, unknown] };
    };
    return { matches: effect.payload.args[0], worker: effect.payload.args[1] };
}

describe("OpenModuleSaga", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("forks the worker for its own action", () => {
        const { matches, worker } = wiring();

        expect(matches(REQUEST)).toBe(true);
        expect(worker).toBe(openModuleWorker);
    });

    it("ignores everything else, including what is not an action at all", () => {
        const { matches } = wiring();

        expect(matches({ type: "a12/somethingElse" })).toBe(false);
        expect(matches({ type: `${OPEN_MODULE}/suffixed` })).toBe(false);
        expect(matches(undefined)).toBe(false);
        expect(matches(null)).toBe(false);
        expect(matches("a string")).toBe(false);
    });
});
