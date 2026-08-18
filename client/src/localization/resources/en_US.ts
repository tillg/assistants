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

import type { LocalizationKeyTreeType } from "../keys";

export const en_US: LocalizationKeyTreeType = {
    application: {
        title: "Assistants",
        header: {
            userinfo: {
                labels: {
                    loggedInAs: "Logged in as",
                    logoutButton: "Logout"
                }
            }
        }
    },

    locale: {
        en: "English (EN)",
        de: "German (DE)"
    },

    keycloak: {
        processing: {
            message: "Signing you in…"
        },
        error: {
            message: "Signing in failed. Reload the page to try again."
        }
    },

    markdownEditor: {
        mode: {
            visual: "Visual",
            markdown: "Markdown"
        },
        toc: {
            ariaLabel: "Table of contents",
            empty: "No headings in range",
            settingsTitle: "Heading levels",
            minLevel: "Min level",
            maxLevel: "Max level"
        },
        block: {
            paragraph: "Paragraph",
            heading: "Heading $level$",
            quote: "Quote",
            code: "Code block",
            typeMenu: "Block type",
            bulletList: "Bullet list",
            numberedList: "Numbered list",
            checkList: "Check list"
        },
        format: {
            bold: "Bold",
            italic: "Italic",
            strikethrough: "Strikethrough",
            textColor: "Text color"
        },
        history: {
            undo: "Undo",
            redo: "Redo"
        },
        insert: {
            menu: "Insert",
            table: "Table",
            image: "Image",
            horizontalRule: "Horizontal rule",
            tableOfContents: "Table of contents",
            link: "Link"
        },
        panel: {
            group: "Panel",
            info: "Info",
            warning: "Warning",
            note: "Note",
            tip: "Tip",
            panel: "Panel"
        },
        table: {
            insertRowAbove: "Insert row above",
            insertRowBelow: "Insert row below",
            insertColumnLeft: "Insert column left",
            insertColumnRight: "Insert column right",
            deleteRow: "Delete row",
            deleteColumn: "Delete column",
            deleteTable: "Delete table"
        },
        link: {
            button: "Insert link",
            text: "Link text",
            url: "Link URL",
            apply: "Apply",
            cancel: "Cancel"
        },
        image: {
            url: "Image URL",
            alt: "Alt text",
            insert: "Insert",
            cancel: "Cancel"
        },
        color: {
            hex: "Color (hex or name)",
            apply: "Apply",
            clear: "Clear color",
            cancel: "Cancel"
        }
    },

    conversation: {
        about: "about",
        scheduledFor: "scheduled for",
        calledBy: "called by",
        waitingForYou: "waiting for you",
        turn: "turn",
        recorded: "recorded",
        answer: "Answer"
    },

    error: {
        security: {
            notAuthorized: {
                description: "You are not allowed to perform the requested operation."
            }
        },
        attachment: {
            invalidType: "Invalid MIME type."
        },
        "content-store": {
            content: {
                invalidSize: "The attachment content exceeds the maximum permitted size."
            }
        },
        serverUnavailable: {
            title: "Server Unavailable",
            message: "The server is currently unavailable. Please try again.",
            retry: "Retry"
        }
    }
};
