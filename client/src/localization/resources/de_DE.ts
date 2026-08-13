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

    keycloak: {
        processing: {
            message: "Sie werden angemeldet…"
        },
        error: {
            message: "Die Anmeldung ist fehlgeschlagen. Laden Sie die Seite neu, um es erneut zu versuchen."
        }
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
