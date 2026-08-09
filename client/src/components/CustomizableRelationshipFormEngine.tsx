/*
 * SPDX-License-Identifier: EUPL-1.2 OR LicenseRef-commercial
 *
 * Copyright (c) 2012-2026 mgm technology partners GmbH
 *
 * Dual License
 * ------------
 * This source file is part of the mgm A12 Platform and available under
 * a choice of two different licenses:
 *
 * 1. Open-Source License - EUPL v1.2
 *    You may redistribute and/or modify this file under the terms of the
 *    European Union Public License, version 1.2 - see https://eupl.eu/.
 *
 * 2. Commercial License
 *    Alternatively, you may obtain a commercial license from
 *    mgm technology partners GmbH, that permits use of this software
 *    under different terms (including support and maintenance services).
 *
 *    Please contact a12-license@mgm-tp.com for more information.
 *
 * You must select and comply with exactly one of the above license options.
 *
 * Warranty Disclaimer (applies to either option)
 * ----------------------------------------------
 * THIS SOFTWARE IS PROVIDED "AS IS" AND WITHOUT WARRANTY OF ANY KIND,
 * WHETHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
 * OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NON-INFRINGEMENT, EXCEPT WHERE SUCH DISCLAIMERS ARE HELD TO BE
 * LEGALLY INVALID. SEE THE RESPECTIVE LICENSE TEXT FOR DETAILS.
 */

import { useDispatch, useSelector } from "react-redux";

import { ModelPath } from "@com.mgmtp.a12.base/base-model-api";
import { ActivitySelectors } from "@com.mgmtp.a12.client/client-core";
import {
    type DefaultStateProps,
    type EngineStore,
    FormEngineActions,
    FormEngineStateAdapter,
    FormEngineViews
} from "@com.mgmtp.a12.formengine/formengine-core";
import { cddActivityStateAdapter } from "@com.mgmtp.a12.relationshipengine/relationshipengine-core";

/**
 * Form Engine view with legacy relationship (CDD) support.
 *
 * Copied from the platform's own `CRUDViews.FormEngineView`, which hardcodes its `formModelMap` and whose
 * props type explicitly omits `formModelMap`/`widgetMap` ("`CRUDViews` are not intended for such
 * modifications"). The `formEngine.viewConfig` from `appsetup` is spread onto whatever component is
 * registered for the `FormEngine` view, so those two maps *arrive* here as props — they just have to be
 * forwarded rather than discarded. That is what wires up the Markdown editor
 * (`formModelMap.Control` → `widgetMap.TextAreaStateless`).
 *
 * The documented alternative for a customized form — `FormEngineViews.FormEngine` — is not usable either:
 * it reads the activity's plain document, while the app is set up with `withRelationshipFormEngine`, which
 * keeps the document in the relationship engine's CDD slice; only {@link cddActivityStateAdapter} folds that
 * back into the shape the Form Engine state adapter expects.
 *
 * Both the copy and the original derive their state props, so the selector result is a new object on every
 * store change — hence the explicit {@link areStatePropsEqual}. Without it react-redux re-renders on every
 * dispatched action anywhere in the app and re-runs the whole-state clone in `cddActivityStateAdapter`, and
 * its dev-mode stability check reports the selector as unmemoized.
 */
export function CustomizableRelationshipFormEngine(props: FormEngineViews.FormEngineProps) {
    const stateProps = useSelector(function engineStateSelector(state: object) {
        const activity = ActivitySelectors.activityById(props.activityId)(state);
        if (!activity) {
            return {};
        }
        const adaptedState = cddActivityStateAdapter(activity)(state);
        return FormEngineStateAdapter.mapStateToProps(adaptedState, props);
    }, areStatePropsEqual);

    const dispatch = useDispatch();
    const dispatchProps = FormEngineActions.mapDispatchToProps(dispatch, props);

    return <FormEngineViews.FormEngineTpl {...props} {...stateProps} {...dispatchProps} />;
}

/**
 * Equality for the derived Form Engine state props: the wrappers are recreated on every call, so equality has
 * to be decided on the stable references one level down. `state` covers the whole `EngineState`
 * (`locale`/`data`/`models`/`ui`), `config` the props the view was rendered with — omitting any of them would
 * freeze the form instead of merely re-rendering it.
 *
 * Kept in step with the platform's comparator of the same name, which is `@internal` to `crud-core` and
 * therefore not importable.
 */
export function areStatePropsEqual(
    prevProps: Partial<DefaultStateProps>,
    curProps: Partial<DefaultStateProps>
): boolean {
    if (prevProps.state === undefined || curProps.state === undefined) {
        return prevProps.state === curProps.state;
    }

    if (prevProps.config === undefined || curProps.config === undefined) {
        return prevProps.config === curProps.config;
    }

    return (
        prevProps.state.locale === curProps.state.locale &&
        prevProps.state.data.dirty === curProps.state.data.dirty &&
        prevProps.state.data.document === curProps.state.data.document &&
        isAttachmentStateEqual(prevProps.state.data.attachmentState, curProps.state.data.attachmentState) &&
        prevProps.state.models.documentModel === curProps.state.models.documentModel &&
        prevProps.state.models.formModel === curProps.state.models.formModel &&
        haveSameEntries(prevProps.config, curProps.config) &&
        haveSameEntries(prevProps.state.ui, curProps.state.ui)
    );
}

function isAttachmentStateEqual(
    a1: EngineStore.AttachmentState | undefined,
    a2: EngineStore.AttachmentState | undefined
): boolean {
    return !a1 || !a2
        ? a1 === a2
        : ModelPath.equal(a1.loading ?? [], a2.loading ?? []) &&
              a1.unassigned?.length === a2.unassigned?.length &&
              (a1.unassigned ?? []).every((id, index) => id === a2.unassigned?.[index]) &&
              haveSameEntries(a1.thumbnails ?? {}, a2.thumbnails ?? {});
}

function haveSameEntries<T extends object>(o1: T, o2: T): boolean {
    const keys1 = Object.keys(o1) as (keyof T)[];
    const keys2 = Object.keys(o2);

    return keys1.length === keys2.length && keys1.every((key) => o1[key] === o2[key]);
}
