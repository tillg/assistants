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

import {
    combineFeatures,
    createA12ApplicationSetup,
    addCustomSagas,
    addAdditionalMiddlewares,
    addView,
    addLayout,
    withModel,
    APPLICATION_MODEL_PLACEHOLDER,
    ModelActions,
    type A12ApplicationConfig,
    ApplicationFactories
} from "@com.mgmtp.a12.client/client-core";
import { withPlatformModelLoader } from "@com.mgmtp.a12.client/client-core/modelLoader";
import { withDirtyHandling } from "@com.mgmtp.a12.client/client-core/dirtyHandling";
import { withLocalization } from "@com.mgmtp.a12.client/client-core/localization";
import { withNotifications } from "@com.mgmtp.a12.client/client-core/notification";
import {
    DefaultFormModelMap,
    DefaultWidgetMap as DefaultFormEngineWidgetMap,
    platformAttachmentLoader
} from "@com.mgmtp.a12.formengine/formengine-core";
import {
    RelationshipFormModelMap,
    withRelationshipFormEngine
} from "@com.mgmtp.a12.relationshipengine/relationshipengine-core";
import { withOverviewEngine } from "@com.mgmtp.a12.overviewengine/overviewengine-core";
import { withTreeEngine } from "@com.mgmtp.a12.treeengine/treeengine-core";
import { withCRUD } from "@com.mgmtp.a12.crud/crud-core";
import { withDeepLinking } from "@com.mgmtp.a12.client/client-core/deepLinking";
import { withDataServicesConfiguration } from "@com.mgmtp.a12.client/client-core/dataServicesAdapter";
import { withContentEngine } from "@com.mgmtp.a12.contentengine/contentengine-core";
import { DefaultElementLibrary } from "@com.mgmtp.a12.contentengine/contentengine-default-element-library";

import { MarkdownTextArea } from "./components/markdown-editor/control/MarkdownTextArea";
import { createModelElementBridge } from "./components/ModelElementBridge";
import { CustomScreenElements } from "./components/CustomScreenElements";
import { registerModulesOnSetModelGraphMiddleware, unregisterModulesOnLogoutMiddleware } from "./modules";
import { isProduction } from "./config";
import { enableReduxDevTools } from "./config/devtools";
import { LoadModelGraphSaga } from "./sagas/loadModelGraph";
import { OpenForeignFormSaga } from "./sagas/openForeignForm";
import { OpenModuleSaga } from "./sagas/openModule";
import { enginesViewMap } from "./app/EnginesViewMap";
import { dashboardViewMap } from "./components/dashboard/dashboardViewMap";
import { stabilizeModifications } from "./app/stabilizeModifications";
import { CustomApplicationFrameLayout } from "./app/LayoutProvider";
import { DEFAULT_TRANSLATIONS, supportedLocales, getDateTimeResource } from "./localization";
import { withKeycloak } from "./uaa/withKeycloak";
import { withUaa } from "./uaa/withUaa";

function assertFullyConfigured(
    config: A12ApplicationConfig
): asserts config is A12ApplicationConfig<ApplicationFactories.Config> {
    if (!config.config.model) {
        throw new Error("config.model is required - did you forget withModel()?");
    }
    if (!config.config.modelLoader) {
        throw new Error("config.modelLoader is required - did you forget withPlatformModelLoader()?");
    }
}

export function setup() {
    const initialConfig: A12ApplicationConfig = {
        config: {
            preComputeNewDocuments: true,
            composeEnhancer: isProduction ? undefined : enableReduxDevTools()
        },
        formEngine: {
            sagas: {
                attachmentLoader: platformAttachmentLoader
            },
            // Spread onto the `FormEngine` view as props (see `withConfiguredFormEngine`), which is why that
            // view is `CustomizableRelationshipFormEngine` rather than `CRUDViews.FormEngineView`.
            viewConfig: {
                // The Markdown editor is selected per control by the `widget: markdown-editor` annotation.
                // Widget props carry no annotations, so the bridge publishes the `Control`'s model element
                // into a React context that `MarkdownTextArea` reads.
                // `RelationshipFormModelMap` is spread because that is what `CRUDViews.FormEngineView` used
                // internally before this app took the map over; without it CDD-bound controls, custom screen
                // elements and detached repeats lose their relationship-aware renderers.
                formModelMap: {
                    ...DefaultFormModelMap,
                    ...RelationshipFormModelMap,
                    Control: { component: createModelElementBridge(RelationshipFormModelMap.Control.component) },
                    // A `CustomScreenElement` is `Annotated` itself, so no bridge is needed: the
                    // dispatcher reads the `widget` annotation straight off its own model element.
                    // Overriding the relationship map's entry wholesale is correct here — it falls
                    // through to a platform placeholder when there is no CDD binding, and this
                    // application has no CDM models.
                    CustomScreenElement: { component: CustomScreenElements }
                },
                widgetMap: {
                    ...DefaultFormEngineWidgetMap,
                    TextAreaStateless: MarkdownTextArea
                }
            }
        },
        localization: {
            supportedLocales,
            translationSource: DEFAULT_TRANSLATIONS,
            getDateTimeResource
        },
        uaa: {
            // No identity provider is named here: the server publishes its own OIDC
            // self-configuration under /api, and `UaaClient.init` fetches it. Which realm and
            // which client the application uses is therefore a server-side setting -- see
            // `client-selfconfiguration.oidc` in server/app/.../application-dev.properties.
            configuration: {
                serverURL: "/api",
                automaticallyLogin: true
            }
        },
        deepLinking: {
            onlyWelcomePage: true,
            config: {
                applyTriggers: [ModelActions.addModulesApplicationModels]
            }
        }
    };

    const a12Features = combineFeatures(
        withModel(APPLICATION_MODEL_PLACEHOLDER),
        withDataServicesConfiguration,
        withOverviewEngine,
        withRelationshipFormEngine,
        withCRUD,
        withTreeEngine,
        withContentEngine(DefaultElementLibrary.get().id),
        withPlatformModelLoader
    );

    const a12ExtensionFeatures = combineFeatures(withDirtyHandling, withDeepLinking);

    const viewAndLayoutFeatures = combineFeatures(
        addView("TreeEngine", enginesViewMap.TreeEngine),
        addView("FormEngine", enginesViewMap.FormEngine),
        addView("OverviewEngine", enginesViewMap.OverviewEngine),
        addView("ContentEngine", enginesViewMap.ContentEngine),
        addView("ConversationsTile", dashboardViewMap.ConversationsTile),
        addView("DocumentsTile", dashboardViewMap.DocumentsTile),
        addView("AssistantsTile", dashboardViewMap.AssistantsTile),
        addView("BookkeepingTile", dashboardViewMap.BookkeepingTile),
        addLayout("ApplicationFrame", { component: CustomApplicationFrameLayout })
    );

    const applicationFeatures = combineFeatures(
        viewAndLayoutFeatures,
        addAdditionalMiddlewares(registerModulesOnSetModelGraphMiddleware, unregisterModulesOnLogoutMiddleware),
        addCustomSagas(LoadModelGraphSaga, OpenForeignFormSaga, OpenModuleSaga)
    );

    const configured = stabilizeModifications(
        combineFeatures(
            withLocalization,
            withNotifications,
            withUaa,
            // Order matters: withKeycloak reads `uaa.configuration` and contributes the
            // wrapper that gates the application on a token, so it must come after withUaa.
            withKeycloak,
            a12Features,
            a12ExtensionFeatures,
            applicationFeatures
        )(initialConfig)
    );

    assertFullyConfigured(configured);

    const { store, initialActions, Component } = createA12ApplicationSetup(configured);

    return { store, initialActions, Component };
}
