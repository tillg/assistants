/*
 * SPDX-License-Identifier: EUPL-1.2
 *
 * Copyright (c) 2026 Till Gartner
 *
 * Part of Assistants.
 *
 * Licensed under the European Union Public Licence, version 1.2 - see
 * https://eupl.eu/ and the LICENSE file at the root of this repository.
 * Distributed on an "AS IS" basis, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.
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
