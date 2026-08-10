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
