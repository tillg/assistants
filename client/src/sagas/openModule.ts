import { call, put, select, takeEvery, type SagaGenerator } from "typed-redux-saga";

import { ActivityActions, ActivitySagas, ActivitySelectors } from "@com.mgmtp.a12.client/client-core";
import { LoggerFactory } from "@com.mgmtp.a12.utils/utils-logging";

/**
 * Opening a navigation module — a Dashboard Tile's whole job once it has been clicked.
 *
 * It is `openForeignForm` minus its third step: a Tile opens a module and not a form, so there is no
 * detail to push and therefore no master to push it beside. What is left is the teardown and one
 * `create`, and the teardown is the part neither saga may skip — which is why it lives here and
 * `openForeignForm.ts` imports it rather than keeping a second copy of a handshake whose failure mode
 * is a layout rendering the wrong panes.
 *
 * Leaving the Dashboard makes the teardown matter more than average, not less: the Dashboard's one
 * activity carries four views, and `create` alone would leave all four behind.
 */

const logger = LoggerFactory.getLogger("PT/openModule");

export const OPEN_MODULE = "assistants/openModule";

export interface OpenModulePayload {
    /** The navigation module to open, as the App Model's match conditions name it. */
    readonly module: string;
}

/** A type alias rather than an interface: only the former is assignable to redux' `UnknownAction`. */
export type OpenModuleAction = {
    readonly type: typeof OPEN_MODULE;
    readonly payload: OpenModulePayload;
};

/** Asks for a module. Callers dispatch this and know none of the recipe above. */
export function openModule(payload: OpenModulePayload): OpenModuleAction {
    return { type: OPEN_MODULE, payload };
}

function isOpenModule(action: unknown): action is OpenModuleAction {
    return typeof action === "object" && action !== null && (action as { type?: unknown }).type === OPEN_MODULE;
}

/**
 * Cancels every top-level activity and honours the veto. `false` means the User said no, and a caller
 * that gets it must create nothing.
 *
 * `create` alone leaks the activities of whatever we are leaving: nothing garbage-collects them, the
 * master-detail layout then renders only the last two views, and a leaked activity vetoes the module
 * registry's REMOVE at logout. This is also the dirty-handling veto point — on a read-only screen it
 * completes with no dialog, but the answer may still be *no*.
 */
export function* cancelTopLevelActivities(): SagaGenerator<boolean> {
    const openActivities = Object.keys(yield* select(ActivitySelectors.topLevelActivities()));
    if (openActivities.length === 0) {
        return true;
    }

    yield* put(ActivityActions.cancelRequested({ activityIds: openActivities }));
    return yield* call(ActivitySagas.waitForResponseCancelRequested);
}

export function* OpenModuleSaga(): SagaGenerator<void> {
    yield* takeEvery(isOpenModule, openModuleWorker);
}

/**
 * The jump itself — and, like `openForeignFormWorker`, it swallows its own failures.
 *
 * `takeEvery` *forks* this worker, and an error escaping a fork tears down the parent that forked it. So
 * one failed jump would not fail once: it would end `OpenModuleSaga` for the rest of the session, and
 * every later Tile click would become a click that does nothing at all, with nothing on screen to say
 * why.
 */
export function* openModuleWorker(action: OpenModuleAction): SagaGenerator<void> {
    const { module } = action.payload;

    try {
        // Delegated with `yield*` rather than `call`, so the teardown's own effects are the worker's
        // own effects — the effect stream is exactly the one `openForeignForm` had inline.
        if (!(yield* cancelTopLevelActivities())) {
            return;
        }

        yield* put(ActivityActions.create({ activityDescriptor: { module } }));
    } catch (error) {
        logger.warn(`Could not open ${module}.`, error);
    }
}
