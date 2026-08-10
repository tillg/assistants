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

import {
    addCustomSagas,
    addInitialAction,
    addWrapper,
    combineFeatures,
    setConfigured
} from "@com.mgmtp.a12.client/client-core";
import type { A12ApplicationConfig, RequireFeatures } from "@com.mgmtp.a12.client/client-core";

import { KeycloakBarrier } from "../app/KeycloakBarrier";

import { setRolesForUserAfterTokenRefresh } from "./sagas";
import { uaaIntegration } from "./integration";

/**
 * The Keycloak half of authentication, on top of `withUaa`.
 *
 * `withUaa` (from `uaa-authentication-a12-client`) contributes the reducer, the middlewares
 * and the `UaaProvider`, all of which are authentication-type agnostic. What OIDC needs
 * beyond that is the redirect itself: something to start the authorization-code flow and
 * finish it, a saga to keep the roles across a silent renewal, and a wrapper that renders
 * nothing but a message until a token has arrived.
 *
 * There is deliberately no locale bridge from Keycloak's login screen: A12Realm has
 * `internationalizationEnabled: false`, so no `locale` claim is ever issued and the
 * application's own locale selector is the only one that matters.
 */
type A12ApplicationConfigWithKeycloak = A12ApplicationConfig & { keycloak?: unknown };
type ApplicationWithKeycloakConfig = RequireFeatures<A12ApplicationConfigWithKeycloak, { uaa: true; keycloak?: never }>;

const addKeycloakSagas = <T extends ApplicationWithKeycloakConfig>(cfg: T) =>
    addCustomSagas<T>(setRolesForUserAfterTokenRefresh)(cfg);

const addKeycloakInitialActions = <T extends ApplicationWithKeycloakConfig>(cfg: T) => {
    const configuration = cfg.uaa?.configuration;
    return addInitialAction<T>(async (store) => {
        if (configuration) {
            await uaaIntegration({ ...configuration, store });
        }
    })(cfg);
};

export const withKeycloak = <T extends ApplicationWithKeycloakConfig>(cfg: T) =>
    setConfigured<T, "keycloak">("keycloak")(
        combineFeatures(addKeycloakSagas, addKeycloakInitialActions, addWrapper(KeycloakBarrier))(cfg)
    );
