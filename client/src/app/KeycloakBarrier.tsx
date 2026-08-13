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
