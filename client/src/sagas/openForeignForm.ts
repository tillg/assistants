import { call, put, select, takeEvery, type SagaGenerator } from "typed-redux-saga";

import { ActivityActions, ActivitySagas, ActivitySelectors } from "@com.mgmtp.a12.client/client-core";

/**
 * Opening a form that belongs to another navigation module.
 *
 * Region content is a pure derivation over the activity map, so nothing routes and nothing has to be
 * taught what a module is. Three steps do it, and all three are load-bearing:
 *
 * 1. **Tear down what we are leaving.** `create` alone leaks the source module's activities: nothing
 *    garbage-collects them, the master-detail layout renders only the last two views, and a leaked
 *    activity vetoes the module registry's REMOVE at logout. This is also the dirty-handling veto point
 *    — on a read-only form it completes with no dialog, but the answer may still be *no*.
 * 2. **Push a master.** A lone top-level form activity has nowhere to go: `event_cancel` removes it and
 *    the region renders an empty div. Which module the master is, is the caller's decision, which is why
 *    `masterModule` is a parameter — answering a question keeps a Conversations master, while opening an
 *    Invoice belongs beside the Invoice list.
 * 3. **Push the detail.** The `create` is what loads the document: it defaults the data holder to
 *    `missing`, which becomes `loadData`, which the platform's single-document provider claims.
 *
 * Two details are the likeliest bugs in a naive version. `model` is **mandatory** — model resolution
 * filters a scene's model descriptors by it, and omitting it means no provider claims the load. And
 * `instance` is a **docRef**, `<Model>/<ThingID>`, not the bare ThingID a Thing carries (ADR-0002: a
 * ThingID identifies and nothing more), because the form's load constrains `/__meta/docRef` to it.
 */

export const OPEN_FOREIGN_FORM = "assistants/openForeignForm";

export interface OpenForeignFormPayload {
    /** The navigation module the form lives in. */
    readonly module: string;
    /** The Document Model that loads it. Mandatory: without it no data provider claims the load. */
    readonly documentModel: string;
    /** A bare ThingID. The docRef is composed here, because no Thing carries one. */
    readonly thingId: string;
    /** The module whose overview sits beside the form, so that its `Cancel` lands somewhere. */
    readonly masterModule: string;
}

/** A type alias rather than an interface: only the former is assignable to redux' `UnknownAction`. */
export type OpenForeignFormAction = {
    readonly type: typeof OPEN_FOREIGN_FORM;
    readonly payload: OpenForeignFormPayload;
};

/** Asks for a foreign form. Callers dispatch this and know none of the recipe above. */
export function openForeignForm(payload: OpenForeignFormPayload): OpenForeignFormAction {
    return { type: OPEN_FOREIGN_FORM, payload };
}

function isOpenForeignForm(action: unknown): action is OpenForeignFormAction {
    return typeof action === "object" && action !== null && (action as { type?: unknown }).type === OPEN_FOREIGN_FORM;
}

export function* OpenForeignFormSaga(): SagaGenerator<void> {
    yield* takeEvery(isOpenForeignForm, openForeignFormWorker);
}

export function* openForeignFormWorker(action: OpenForeignFormAction): SagaGenerator<void> {
    const { module, documentModel, thingId, masterModule } = action.payload;

    const openActivities = Object.keys(yield* select(ActivitySelectors.topLevelActivities()));
    if (openActivities.length > 0) {
        yield* put(ActivityActions.cancelRequested({ activityIds: openActivities }));
        if (!(yield* call(ActivitySagas.waitForResponseCancelRequested))) {
            return;
        }
    }

    const master = ActivityActions.create({ activityDescriptor: { module: masterModule } });
    yield* put(master);
    yield* put(
        ActivityActions.create({
            activityDescriptor: { module, instance: `${documentModel}/${thingId}`, model: documentModel },
            initiatingActivityId: master.payload.activity.id
        })
    );
}
