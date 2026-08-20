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
 * The attachment preview's own visible strings, in the locale the app is showing.
 *
 * Like the transcript, this is bespoke React the A12 shell does not localise off a model, so its
 * two literals are read here instead. It reuses {@link transcriptLanguage} — the shared rule that
 * reads the `locale` the LocaleSelect writes to localStorage — rather than editing the resource
 * bundles, so the preview stays a self-contained addition. English is the fallback.
 */

import { transcriptLanguage } from "../conversation/localize";

interface PreviewStrings {
    readonly loading: string;
    readonly download: string;
}

const STRINGS: Record<"en" | "de", PreviewStrings> = {
    en: { loading: "Loading preview…", download: "Download" },
    de: { loading: "Vorschau wird geladen…", download: "Herunterladen" }
};

export function previewStrings(): PreviewStrings {
    return STRINGS[transcriptLanguage()];
}
