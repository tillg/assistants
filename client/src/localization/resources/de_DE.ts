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

export const de_DE: LocalizationKeyTreeType = {
    application: {
        title: "Assistants",
        header: {
            userinfo: {
                labels: {
                    loggedInAs: "Angemeldet als",
                    logoutButton: "Ausloggen"
                }
            }
        }
    },

    locale: {
        en: "Englisch (EN)",
        de: "Deutsch (DE)"
    },

    markdownEditor: {
        mode: {
            visual: "Visuell",
            markdown: "Markdown"
        },
        toc: {
            ariaLabel: "Inhaltsverzeichnis",
            empty: "Keine Überschriften im Bereich",
            settingsTitle: "Überschriftenebenen",
            minLevel: "Min. Ebene",
            maxLevel: "Max. Ebene"
        },
        block: {
            paragraph: "Absatz",
            heading: "Überschrift $level$",
            quote: "Zitat",
            code: "Codeblock",
            typeMenu: "Blocktyp",
            bulletList: "Aufzählung",
            numberedList: "Nummerierte Liste",
            checkList: "Checkliste"
        },
        format: {
            bold: "Fett",
            italic: "Kursiv",
            strikethrough: "Durchgestrichen",
            textColor: "Textfarbe"
        },
        history: {
            undo: "Rückgängig",
            redo: "Wiederholen"
        },
        insert: {
            menu: "Einfügen",
            table: "Tabelle",
            image: "Bild",
            horizontalRule: "Trennlinie",
            tableOfContents: "Inhaltsverzeichnis",
            link: "Link"
        },
        panel: {
            group: "Panel",
            info: "Info",
            warning: "Warnung",
            note: "Notiz",
            tip: "Tipp",
            panel: "Panel"
        },
        table: {
            insertRowAbove: "Zeile oberhalb einfügen",
            insertRowBelow: "Zeile unterhalb einfügen",
            insertColumnLeft: "Spalte links einfügen",
            insertColumnRight: "Spalte rechts einfügen",
            deleteRow: "Zeile löschen",
            deleteColumn: "Spalte löschen",
            deleteTable: "Tabelle löschen"
        },
        link: {
            button: "Link einfügen",
            text: "Linktext",
            url: "Link-URL",
            apply: "Anwenden",
            cancel: "Abbrechen"
        },
        image: {
            url: "Bild-URL",
            alt: "Alternativtext",
            insert: "Einfügen",
            cancel: "Abbrechen"
        },
        color: {
            hex: "Farbe (Hex oder Name)",
            apply: "Anwenden",
            clear: "Farbe entfernen",
            cancel: "Abbrechen"
        }
    },

    error: {
        security: {
            notAuthorized: {
                description: "Sie haben keine Berechtigung diese Operation durchzuführen."
            }
        },
        attachment: {
            invalidType: "Ungültiger MIME-Typ."
        },
        "content-store": {
            content: {
                invalidSize: "Der Attachment-Inhalt überschreitet die zulässige Maximalgröße."
            }
        },
        serverUnavailable: {
            title: "Server nicht verfügbar",
            message: "Der Server ist derzeit nicht verfügbar. Bitte versuchen Sie es erneut.",
            retry: "Erneut versuchen"
        }
    }
};
