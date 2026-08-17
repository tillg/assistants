import { put, takeEvery, type SagaGenerator } from "typed-redux-saga";

import { ActivityActions } from "@com.mgmtp.a12.client/client-core";
import { LoggerFactory } from "@com.mgmtp.a12.utils/utils-logging";

import { cancelTopLevelActivities } from "./openModule";

/**
 * Opening a form that belongs to another navigation module.
 *
 * Region content is a pure derivation over the activity map, so nothing routes and nothing has to be
 * taught what a module is. Three steps do it, and all three are load-bearing:
 *
 * 1. **Tear down what we are leaving.** `cancelTopLevelActivities` in {@link ./openModule}, which owns
 *    that handshake for both sagas and documents why it is not optional.
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

const logger = LoggerFactory.getLogger("PT/openForeignForm");

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

/**
 * The jump itself — and it swallows its own failures, which is the one thing about it that is not
 * obvious.
 *
 * `takeEvery` *forks* this worker, and an error escaping a fork tears down the parent that forked it. So
 * a single failed jump would not fail once: it would end `OpenForeignFormSaga` for the rest of the
 * session, and every later **Answer**, *about* and *called by* would become a click that does nothing at
 * all, with nothing on screen to say why. A navigation that could not be made is worth a log line; it is
 * never worth the navigation that comes after it.
 */
export function* openForeignFormWorker(action: OpenForeignFormAction): SagaGenerator<void> {
    const { module, documentModel, thingId, masterModule } = action.payload;

    try {
        if (!(yield* cancelTopLevelActivities())) {
            return;
        }

        const master = ActivityActions.create({ activityDescriptor: { module: masterModule } });
        yield* put(master);
        yield* put(
            ActivityActions.create({
                activityDescriptor: { module, instance: `${documentModel}/${thingId}`, model: documentModel },
                initiatingActivityId: master.payload.activity.id
            })
        );
    } catch (error) {
        logger.warn(`Could not open ${module}'s form for ${documentModel}/${thingId}.`, error);
    }
}
