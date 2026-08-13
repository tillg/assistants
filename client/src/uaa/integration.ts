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
    AuthenticationState,
    UaaClient,
    type UaaClientConfiguration,
    UaaSelectors
} from "@com.mgmtp.a12.uaa/uaa-authentication-client";
import { LoggerFactory } from "@com.mgmtp.a12.utils/utils-logging";

const logger = LoggerFactory.getLogger("uaa/integration");

/**
 * Keycloak sends the browser back with `code` and `state` query parameters. `state` is the
 * one of the two that is always present, including on the error paths, so it is what tells a
 * callback apart from someone simply opening the application.
 */
export function isRedirectFromKeyCloak() {
    const appURL = new URL(window.location.href);
    return appURL.searchParams.has("state");
}

/**
 * Drives the two halves of the authorization-code flow, as the initial action of the
 * application: either finish a redirect Keycloak has just sent us back from, or start one.
 *
 * There is no login form in this application. `UaaClient` exchanges the authorization code
 * for a token, hands the token to UAA, and UAA answers with the user and their roles.
 */
export async function uaaIntegration(clientConfiguration: UaaClientConfiguration) {
    await UaaClient.init(clientConfiguration);

    const appURL = new URL(window.location.href);
    const uaaOidcClient = UaaClient.getOidcClient();

    if (isRedirectFromKeyCloak()) {
        try {
            logger.info("UAA process for callback.");
            uaaOidcClient.initConnector();
            await uaaOidcClient.processLoginCallback();
        } catch {
            // A stale or replayed `state` cannot be recovered from -- start over rather than
            // leave the user on a page that will never authenticate.
            uaaOidcClient.login();
        } finally {
            // Drop Keycloak's parameters from the address bar. They are single-use, and
            // leaving them there makes a reload look like a second callback.
            const baseUrl = `${appURL.origin}${appURL.pathname}`;
            window.history.pushState("name", "", baseUrl);
        }
    } else {
        logger.info("Start trigger UAA process for login.");
        const authenticatedState = UaaSelectors.state(clientConfiguration.store?.getState());
        const isNotAuthenticated = authenticatedState === AuthenticationState.NOT_AUTHENTICATED;
        if (isNotAuthenticated) {
            uaaOidcClient.login();
        }
    }
}
