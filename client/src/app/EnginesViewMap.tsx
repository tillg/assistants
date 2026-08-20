/*
 * SPDX-License-Identifier: EUPL-1.2
 *
 * Copyright (c) 2026 Till Gartner
 * Copyright (c) 2012-2026 mgm technology partners GmbH
 *
 * Part of Assistants. Derived from the mgm A12 project template, which mgm
 * licenses as EUPL-1.2 or commercial; Assistants takes the EUPL-1.2 option,
 * so this file is distributed here under EUPL-1.2 only.
 *
 * Licensed under the European Union Public Licence, version 1.2 - see
 * https://eupl.eu/ and the LICENSE file at the root of this repository.
 * Distributed on an "AS IS" basis, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.
 */

import styled from "styled-components";

import type { View } from "@com.mgmtp.a12.client/client-core";
import { CRUDViews } from "@com.mgmtp.a12.crud/crud-core";
import { TreeEngineFactories } from "@com.mgmtp.a12.treeengine/treeengine-core";
import { DefaultElementLibraryFactories } from "@com.mgmtp.a12.contentengine/contentengine-default-element-library";
import { withFormElementContexts } from "@com.mgmtp.a12.formengine/formengine-content-elements";

import { CustomizableRelationshipFormEngine } from "../components/CustomizableRelationshipFormEngine";
import { DocumentAttachmentPane } from "../components/document/DocumentAttachmentPane";

type ViewMap = Record<string, View.ViewComponent | undefined>;

/**
 * Form and (for a Document) its attachment preview, side by side. `flex-wrap` is the whole trick: on a
 * wide screen the form and the ~A4 preview sit next to each other, so a Document opens with its fields
 * *and* its PDF both on screen — which is the point, since checking the Receptionist's classification
 * against the document means seeing both at once. When the two cannot both fit (a narrow window), the
 * preview wraps beneath the form. When the pane renders nothing — every non-Document form, and a
 * Document whose attachment has no renderer — the form is the only child and takes the full width, so
 * nothing else changes.
 */
const FormWithPreview = styled.div`
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 1.5rem;
`;

/** The form's column: grows to fill, and `min-width: 0` lets its own grid reflow instead of overflowing. */
const FormColumn = styled.div`
    flex: 1 1 480px;
    min-width: 0;
`;

/**
 * View map for the engines used in the App Model.
 *
 * Maps view names specified in the App Model Scenes to React components of the respective engine.
 * Each entry must be registered via a corresponding `addView()` call in `appsetup.ts`.
 *
 * `FormEngine` is {@link CustomizableRelationshipFormEngine} rather than `CRUDViews.FormEngineView`,
 * because the latter drops the `formModelMap`/`widgetMap` that `formEngine.viewConfig` in `appsetup.ts`
 * injects as props — see that component's doc comment.
 */
export const enginesViewMap = {
    TreeEngine(props) {
        return <TreeEngineFactories.ViewComponent {...props} />;
    },
    FormEngine(props) {
        // The Document form grows a read-only attachment preview beside it (wrapping beneath on a narrow
        // window). The pane self-gates on the activity's model, so every other form is the sole child and
        // renders full-width exactly as before — see {@link DocumentAttachmentPane}.
        return (
            <FormWithPreview>
                <FormColumn>
                    <CustomizableRelationshipFormEngine {...props} />
                </FormColumn>
                <DocumentAttachmentPane activityId={props.activityId} />
            </FormWithPreview>
        );
    },
    OverviewEngine(props) {
        return <CRUDViews.OverviewEngineView {...props} />;
    },
    ContentEngine: withFormElementContexts({
        ViewComponent: DefaultElementLibraryFactories.ViewComponent
    })
} satisfies ViewMap;
