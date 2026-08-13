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

import type { View } from "@com.mgmtp.a12.client/client-core";
import { CRUDViews } from "@com.mgmtp.a12.crud/crud-core";
import { TreeEngineFactories } from "@com.mgmtp.a12.treeengine/treeengine-core";
import { DefaultElementLibraryFactories } from "@com.mgmtp.a12.contentengine/contentengine-default-element-library";
import { withFormElementContexts } from "@com.mgmtp.a12.formengine/formengine-content-elements";

import { CustomizableRelationshipFormEngine } from "../components/CustomizableRelationshipFormEngine";

type ViewMap = Record<string, View.ViewComponent | undefined>;

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
        return <CustomizableRelationshipFormEngine {...props} />;
    },
    OverviewEngine(props) {
        return <CRUDViews.OverviewEngineView {...props} />;
    },
    ContentEngine: withFormElementContexts({
        ViewComponent: DefaultElementLibraryFactories.ViewComponent
    })
} satisfies ViewMap;
