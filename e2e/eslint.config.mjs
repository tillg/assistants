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

import clientRules from "../client/eslint.config.mjs";

export default [
    {
        ignores: ["**/node_modules"]
    },
    ...clientRules,
    {
        settings: {
            react: {
                version: "18.2"
            }
        },
        rules: {
            "@typescript-eslint/no-namespace": "off",
            "max-nested-callbacks": ["error", 5],
            "import/no-extraneous-dependencies": ["error", { devDependencies: true }],
            // A Playwright fixture has no other channel: a context that will not close, or a
            // sessionStorage write refused inside the browser, is worth saying out loud in the run
            // output. `console.log` stays banned — that is the one that gets left behind by accident.
            "no-console": ["error", { allow: ["warn", "error"] }]
        }
    }
];
