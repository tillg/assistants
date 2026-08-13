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

import path from "node:path";

/** The UserInterface — the A12 web application. */
export const BASE_URL = process.env.BASE_URL || "http://localhost:8081";

/** The ThingStore — the A12 Data Service. JSON-RPC lives under `/api/v2/rpc`. */
export const THINGSTORE_URL = process.env.THINGSTORE_URL || "http://localhost:8082";

/**
 * Bookkeeping — Firefly III. REST lives under `/api/v1`.
 *
 * This is oauth2-proxy's port, not Firefly's: Firefly publishes none. `/api/` and
 * `/healthcheck` are the routes the proxy passes straight through, because Firefly checks its
 * personal access token on a guard of its own. Anything else here would land on Keycloak.
 */
export const FIREFLY_URL = process.env.FIREFLY_URL || "http://localhost:8084";

/**
 * Keycloak — the identity provider. Every login in this tier goes through it: the browser ones
 * as a redirect to its login form, the API ones as a direct access grant against
 * {@link KEYCLOAK_CLIENT_ID}, which is the only realm client permitting that grant.
 */
export const KEYCLOAK_URL = process.env.KEYCLOAK_URL || "http://localhost:8089";
export const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM || "A12Realm";
export const KEYCLOAK_CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID || "assistants-runtime-client";

/** The repository root, so the flow tests can drive `docker compose` the way `just` does. */
export const REPO_ROOT = path.resolve(process.cwd(), "..");

/** The compose invocation the justfile uses, minus the `docker` binary itself. */
export const COMPOSE_ARGS = ["compose", "-f", "compose/docker-compose.yml", "--env-file", ".env"];

/**
 * Everything these tests create carries this prefix, so a clean-up pass can tell its own
 * leftovers from the demo household — and never delete the latter.
 */
export const E2E_PREFIX = "E2E";

/**
 * The Runtime scans every two seconds and the invoice slice takes several turns across two
 * Assistants, with a human answer in the middle. Nothing here is fast; be generous.
 */
export const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 180_000);
