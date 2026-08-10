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
