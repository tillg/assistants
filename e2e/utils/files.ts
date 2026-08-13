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

import fs from "node:fs/promises";
import path from "node:path";

import type { TestUsername, SessionStorageData } from "../types";

const AUTH_DIR = path.resolve(".auth");

export async function ensureAuthDirExists(): Promise<void> {
    await fs.mkdir(AUTH_DIR, { recursive: true });
}

/**
 * Playwright's own storage state: cookies and localStorage.
 *
 * Cookies are the half that used to be unnecessary and now is not. Under Keycloak the
 * application never authenticates from storage alone — its initial action always asks the
 * identity provider, and it is Keycloak's SSO cookie that makes the round trip silent. A context
 * without that cookie lands on the login form no matter what else was restored into it.
 */
export function getUserAuthStorageStatePath(username: TestUsername): string {
    return path.join(AUTH_DIR, `${username}.json`);
}

/** The sessionStorage dump, which Playwright's storage state does not cover. */
export function getUserSessionStoragePath(username: TestUsername): string {
    return path.join(AUTH_DIR, `${username}.session.json`);
}

export async function deleteAuthDir(): Promise<void> {
    await fs.rm(AUTH_DIR, { recursive: true, force: true });
}

export async function writeUserSessionData(username: TestUsername, sessionData: SessionStorageData): Promise<void> {
    await fs.writeFile(getUserSessionStoragePath(username), JSON.stringify(sessionData, null, 2));
}

export async function getUserSessionData(username: TestUsername): Promise<SessionStorageData> {
    const data = await fs.readFile(getUserSessionStoragePath(username), "utf-8");
    return JSON.parse(data);
}
