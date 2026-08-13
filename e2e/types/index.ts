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

import USERS from "../fixtures/users.json" with { type: "json" };

export interface FileTestData {
    locator: string;
    filePath: string;
    value: string;
    type: DataType.File;
}
export interface FieldTestData {
    label: string;
    value: string;
    type: Exclude<DataType, DataType.File>;
}

export type TestData = FieldTestData | FileTestData;

export enum DataType {
    String,
    Select,
    Check,
    File,
    /**
     * A `StringType` carrying a `hintList`. The form engine renders those as an autocomplete —
     * an `<input role="combobox">` that still accepts free text — so it is neither a plain
     * textbox nor a `<select>`, and needs its own handling.
     */
    Autocomplete
}

export type TestUsername = keyof typeof USERS;
export const USERNAMES = Object.keys(USERS) as TestUsername[];

export type SessionStorageData = Record<string, string>;
