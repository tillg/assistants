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

import type { PropsWithChildren, ReactNode } from "react";
import { useSelector } from "react-redux";

import { AuthenticationState, UaaSelectors } from "@com.mgmtp.a12.uaa/uaa-authentication-client";
import { GlobalMessageBox } from "@com.mgmtp.a12.widgets/widgets-core";

import { RESOURCE_KEYS, useLocalizer } from "../localization";

/**
 * Holds the application back until a Keycloak token has arrived.
 *
 * This replaces the login form the UAA `LOCAL` type provided: no password is ever typed
 * here, so the only two states worth showing are "being redirected" and "that failed". The
 * window is short -- a redirect out to Keycloak and back -- but it is not empty, and a blank
 * page during it is indistinguishable from a broken one.
 */
export function KeycloakBarrier({ children }: Readonly<PropsWithChildren>): ReactNode {
    const authenticatedState = useSelector(UaaSelectors.state);
    const isAuthenticated = authenticatedState === AuthenticationState.AUTHENTICATED;
    const uaaError = !!useSelector(UaaSelectors.error);
    const localizer = useLocalizer();

    if (!isAuthenticated) {
        return (
            <GlobalMessageBox
                variant={uaaError ? "error" : "info"}
                content={
                    uaaError
                        ? localizer(RESOURCE_KEYS.keycloak.error.message)
                        : localizer(RESOURCE_KEYS.keycloak.processing.message)
                }
            />
        );
    }

    return children;
}
