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

import { put, select, takeLatest, type SagaGenerator } from "typed-redux-saga";

import { isUaaOidcUser, UaaActions, UaaSelectors } from "@com.mgmtp.a12.uaa/uaa-authentication-client";

/**
 * Carries the user's roles across a silent token renewal.
 *
 * The renewed token is a fresh OIDC user object, and the A12 authorities that came with the
 * old one are not part of it -- they came from UAA's `currentUser`, not from Keycloak. Without
 * this, every module the user may see disappears roughly a minute before the access token
 * would have expired, which is exactly the sort of failure nobody reproduces on demand.
 */
export function* setRolesForUserAfterTokenRefresh(): SagaGenerator<void> {
    yield* takeLatest(UaaActions.oidc_user_expiring, handle);

    function* handle(): SagaGenerator<void> {
        const user = yield* select(UaaSelectors.user);
        if (isUaaOidcUser(user)) {
            yield* put(UaaActions.modifyingOidcUser(user));
        }
    }
}
