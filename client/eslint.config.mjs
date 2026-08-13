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

import { fixupConfigRules, fixupPluginRules } from "@eslint/compat";
import typescriptEslint from "@typescript-eslint/eslint-plugin";
import _import from "eslint-plugin-import";
import jambitTypedReduxSaga from "@jambit/eslint-plugin-typed-redux-saga";
import globals from "globals";
import tsParser from "@typescript-eslint/parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all
});

export default [
    {
        ignores: [
            "**/build",
            "**/resources",
            "**/node_modules/",
            "**/target",
            "**/scripts",
            "**/webpack.*.js",
            "prettier.config.js",
            "eslint.config.mjs",
            "vitest.config.ts",
            "vitest.setup.ts",
            "**/*.generated.*"
        ]
    },
    {
        files: ["**/*.ts", "**/*.tsx"]
    },
    ...fixupConfigRules(
        compat.extends(
            "eslint:recommended",
            "plugin:@typescript-eslint/eslint-recommended",
            "plugin:@typescript-eslint/recommended",
            "plugin:import/typescript",
            "plugin:react/recommended",
            "plugin:react/jsx-runtime",
            "plugin:react-hooks/recommended",
            "prettier"
        )
    ),
    {
        plugins: {
            "@typescript-eslint": fixupPluginRules(typescriptEslint),
            import: fixupPluginRules(_import),
            "@jambit/typed-redux-saga": jambitTypedReduxSaga
        },

        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.node
            },

            parser: tsParser
        },
        settings: {
            "import/internal-regex": "^@com.mgmtp.a12",
            react: {
                version: "detect"
            }
        },
        rules: {
            "import/order": [
                "error",
                {
                    groups: ["builtin", "external", "internal", "parent", "sibling", "index"],

                    pathGroups: [
                        {
                            pattern: "../**",
                            group: "parent",
                            position: "after"
                        }
                    ],

                    "newlines-between": "always"
                }
            ],

            "import/newline-after-import": [
                "error",
                {
                    count: 1
                }
            ],

            "import/no-duplicates": "error",

            curly: "error",
            eqeqeq: "error",
            "@jambit/typed-redux-saga/use-typed-effects": "error",
            "@jambit/typed-redux-saga/delegate-effects": "error",
            "no-console": "error",

            "no-restricted-imports": [
                "error",
                {
                    patterns: [
                        "../**/internal/*",
                        "@com.mgmtp.a12*/**/internal/**",
                        "@com.mgmtp.a12*/**/a12internal/**",
                        "@com.mgmtp.a12*/**/src/**",
                        "lodash*"
                    ]
                }
            ],

            "import/no-internal-modules": [
                "warn",
                {
                    forbid: ["@com.mgmtp.a12*/*/*/**"]
                }
            ],

            "max-nested-callbacks": [
                "error",
                {
                    max: 3
                }
            ],

            "import/no-extraneous-dependencies": [
                "error",
                {
                    devDependencies: [
                        "**/*.test.ts",
                        "**/*.test.tsx",
                        "**/*.spec.ts",
                        "**/*.spec.tsx",
                        "**/markdownTestUtils.ts"
                    ],
                    optionalDependencies: false,
                    peerDependencies: false,
                    bundledDependencies: false
                }
            ],
            "react/prop-types": "off"
        }
    }
];
