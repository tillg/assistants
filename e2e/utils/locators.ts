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

import type { Locator } from "@playwright/test";

import type { Page } from "../fixtures";
import { DataType } from "../types";

export function getByLabelWithOptionalAsterisk(scope: Page | Locator, label: string, type?: DataType): Locator {
    const labelRegex = new RegExp(`^${label}\\s*\\*?$`);

    switch (type) {
        case DataType.String:
            return scope.getByRole("textbox", { name: labelRegex });
        case DataType.Select:
        case DataType.Autocomplete:
            return scope.getByRole("combobox", { name: labelRegex });
        case DataType.Check:
            return scope.getByRole("checkbox", { name: labelRegex });
        default:
            return scope.getByLabel(labelRegex);
    }
}
