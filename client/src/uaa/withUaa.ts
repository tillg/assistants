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
    addAdditionalMiddlewares,
    addApplicationBusyTriggers,
    combineFeatures,
    setConfigured,
    withApplicationResetTriggers,
    withReducerMap
} from "@com.mgmtp.a12.client/client-core";
import { UaaActions, UaaMiddlewares, UaaReducer } from "@com.mgmtp.a12.uaa/uaa-authentication-client";
import type { ApplicationWithUaaConfig } from "@com.mgmtp.a12.uaa/uaa-authentication-a12-client";

/**
 * UAA's store wiring, and deliberately NOT `withUaa` from `uaa-authentication-a12-client`.
 *
 * The packaged version looks like a superset of this one -- same reducer, same middlewares,
 * more busy triggers -- but it also wraps the application in `UaaProvider`, which calls
 * `UaaClient.init` itself. Together with the `init` in `uaaIntegration` that makes two, and the
 * second one re-runs `configureClientsAndTokens`: it rebuilds the OIDC client and resets token
 * management while the application is already loading its models. Any request in flight across
 * that window goes out with no `Authorization` header, and the one that matters is the JSON-RPC
 * call that fetches the Application Model -- a 401 there renders an empty page with only
 * "At least one application model failed to load!" on the console. It reproduced about four
 * times in five.
 *
 * So initialisation happens in exactly one place, `uaaIntegration`, which is also how the A12
 * Project Template's Keycloak variant does it. Nothing is lost by dropping the provider:
 * `UaaMiddlewares()` starts `uaaSaga` on the first action it sees.
 */
const addUaaBusyTriggers = <T extends ApplicationWithUaaConfig>(cfg: T) =>
    addApplicationBusyTriggers({
        start: [UaaActions.loggingInOIDC],
        end: [UaaActions.loggedIn, UaaActions.loginFailed]
    })(cfg);

const addUaaResetTriggers = <T extends ApplicationWithUaaConfig>(cfg: T) =>
    withApplicationResetTriggers({
        resetRequested: [UaaActions.logoutRequested],
        resetConfirmed: UaaActions.loggingOut(),
        reset: [UaaActions.loggedOut]
    })(cfg);

const addUaaMiddlewares = <T extends ApplicationWithUaaConfig>(cfg: T) =>
    addAdditionalMiddlewares(...UaaMiddlewares())(cfg);

const addUaaReducers = <T extends ApplicationWithUaaConfig>(cfg: T) => withReducerMap({ uaa: UaaReducer })(cfg);

export const withUaa = <T extends ApplicationWithUaaConfig>(cfg: T) =>
    setConfigured("uaa")(
        combineFeatures(addUaaBusyTriggers, addUaaResetTriggers, addUaaMiddlewares, addUaaReducers)(cfg)
    );
