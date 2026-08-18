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

import { initializeKeys } from "@com.mgmtp.a12.utils/utils-localization";
import { DIRTY_HANDLING_RESOURCE_KEYS } from "@com.mgmtp.a12.client/client-core/dirtyHandling";
import { HETEROGENEITY_RESOURCE_KEYS } from "@com.mgmtp.a12.client/client-core/heterogeneity";
import {
    FRAME_RESOURCE_KEYS,
    LOCALE_RESOURCE_KEYS,
    LOCALE_SELECT_RESOURCE_KEYS
} from "@com.mgmtp.a12.client/client-core";
import { RESOURCE_KEYS as FORMENGINE_RESOURCE_KEYS } from "@com.mgmtp.a12.formengine/formengine-core";
import { RESOURCE_KEYS as OVERVIEWENGINE_RESOURCE_KEYS } from "@com.mgmtp.a12.overviewengine/overviewengine-core";
import { RESOURCE_KEYS as TREEENGINE_RESOURCE_KEYS } from "@com.mgmtp.a12.treeengine/treeengine-core";
import {
    CDM_RESOURCE_KEYS,
    RELATIONSHIP_RESOURCE_KEYS
} from "@com.mgmtp.a12.relationshipengine/relationshipengine-core";
import { CRUD_RESOURCE_KEYS } from "@com.mgmtp.a12.crud/crud-core";

/**
 * This mapping provides the key-structure for all custom labels and texts which shall be localized.
 *
 * The key-value pairs for each locale can be found under the 'resources' folder.
 */
export const RESOURCE_KEYS = {
    application: {
        header: {
            userinfo: {
                labels: {
                    loggedInAs: "",
                    logoutButton: ""
                }
            }
        }
    },

    locale: {
        en: "",
        de: ""
    },

    keycloak: {
        processing: {
            message: ""
        },
        error: {
            message: ""
        }
    },

    markdownEditor: {
        mode: {
            visual: "",
            markdown: ""
        },
        toc: {
            ariaLabel: "",
            empty: "",
            settingsTitle: "",
            minLevel: "",
            maxLevel: ""
        },
        block: {
            paragraph: "",
            heading: "",
            quote: "",
            code: "",
            typeMenu: "",
            bulletList: "",
            numberedList: "",
            checkList: ""
        },
        format: {
            bold: "",
            italic: "",
            strikethrough: "",
            textColor: ""
        },
        history: {
            undo: "",
            redo: ""
        },
        insert: {
            menu: "",
            table: "",
            image: "",
            horizontalRule: "",
            tableOfContents: "",
            link: ""
        },
        panel: {
            group: "",
            info: "",
            warning: "",
            note: "",
            tip: "",
            panel: ""
        },
        table: {
            insertRowAbove: "",
            insertRowBelow: "",
            insertColumnLeft: "",
            insertColumnRight: "",
            deleteRow: "",
            deleteColumn: "",
            deleteTable: ""
        },
        link: {
            button: "",
            text: "",
            url: "",
            apply: "",
            cancel: ""
        },
        image: {
            url: "",
            alt: "",
            insert: "",
            cancel: ""
        },
        color: {
            hex: "",
            apply: "",
            clear: "",
            cancel: ""
        }
    },

    conversation: {
        about: "",
        scheduledFor: "",
        calledBy: "",
        waitingForYou: "",
        turn: "",
        recorded: "",
        answer: ""
    },

    error: {
        security: {
            notAuthorized: {
                description: ""
            }
        },
        attachment: {
            invalidType: ""
        },
        "content-store": {
            content: {
                invalidSize: ""
            }
        },
        serverUnavailable: {
            title: "",
            message: "",
            retry: ""
        }
    }
};

initializeKeys(RESOURCE_KEYS);

type DeepPartial<T> = T extends object ? { [P in keyof T]?: DeepPartial<T[P]> } : T;

/** Creates a typing for a localization tree map with A12 localizable keys. */
export type LocalizationKeyTreeType = typeof RESOURCE_KEYS &
    DeepPartial<typeof CDM_RESOURCE_KEYS> &
    DeepPartial<typeof CRUD_RESOURCE_KEYS> &
    DeepPartial<typeof DIRTY_HANDLING_RESOURCE_KEYS> &
    DeepPartial<typeof FRAME_RESOURCE_KEYS> &
    DeepPartial<typeof HETEROGENEITY_RESOURCE_KEYS> &
    DeepPartial<typeof LOCALE_RESOURCE_KEYS> &
    DeepPartial<typeof LOCALE_SELECT_RESOURCE_KEYS> &
    DeepPartial<typeof RELATIONSHIP_RESOURCE_KEYS> &
    DeepPartial<typeof FORMENGINE_RESOURCE_KEYS> &
    DeepPartial<typeof TREEENGINE_RESOURCE_KEYS> &
    DeepPartial<typeof OVERVIEWENGINE_RESOURCE_KEYS>;
