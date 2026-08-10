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
