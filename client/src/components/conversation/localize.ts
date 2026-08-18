/*
 * SPDX-License-Identifier: EUPL-1.2
 *
 * Copyright (c) 2026 Till Gartner
 *
 * Part of Assistants.
 *
 * Licensed under the European Union Public Licence, version 1.2 - see
 * https://eupl.eu/ and the LICENSE file at the root of this repository.
 * Distributed on an "AS IS" basis, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.
 */

/**
 * The transcript's own visible strings, in the locale the app is showing.
 *
 * The A12 shell localises everything modelled — menu, forms, the overview columns — off the models,
 * but the transcript is bespoke React, so its words were literals and stayed English when the User
 * switched to German. This reads them from the resource bundle the same way
 * `ServerUnavailableNotification` reads its own, off the `locale` the LocaleSelect writes to
 * localStorage. English is the fallback and the values are identical to the old literals, so nothing
 * English changes.
 */

import { Locale } from "@com.mgmtp.a12.utils/utils-localization";

import { en_US } from "../../localization/resources/en_US";
import { de_DE } from "../../localization/resources/de_DE";

const LOCALE_LOCAL_STORAGE_KEY = "locale";

export type TranscriptStrings = typeof en_US.conversation;

export function transcriptStrings(): TranscriptStrings {
    try {
        const localeString = localStorage.getItem(LOCALE_LOCAL_STORAGE_KEY) ?? "en";
        return Locale.fromString(localeString).language === "de" ? de_DE.conversation : en_US.conversation;
    } catch {
        return en_US.conversation;
    }
}
