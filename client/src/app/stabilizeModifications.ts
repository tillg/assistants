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

import type { A12ApplicationConfig } from "@com.mgmtp.a12.client/client-core";

type ModificationProvider<T> = (name: string) => ((subject: T) => T) | undefined;

/**
 * Caches each modification's result so a view or layout keeps one component identity.
 *
 * Keyed on the subject as well as the name: a view is first resolved from the module registry, which is
 * populated on `setModelGraph`, so an early lookup can legitimately resolve to a different (placeholder)
 * component than a later one — that has to replace the entry rather than be served from it.
 *
 * Assumes a modification is a pure function of what it wraps, which holds for all of them today (each one
 * only spreads static config onto the component). One that had to be re-evaluated per render would be
 * frozen by this.
 */
function cachePerName<T extends object>(
    source: ModificationProvider<T> | undefined
): ModificationProvider<T> | undefined {
    if (source === undefined) {
        return undefined;
    }
    const cache = new Map<string, { subject: T; result: T }>();
    return (name) => {
        const modify = source(name);
        if (modify === undefined) {
            return undefined;
        }
        return (subject) => {
            const cached = cache.get(name);
            if (cached?.subject === subject) {
                return cached.result;
            }
            const result = modify(subject);
            cache.set(name, { subject, result });
            return result;
        };
    };
}

/**
 * Stops every view in a region from being destroyed and rebuilt whenever that region's layout re-renders
 * (A12-19155).
 *
 * The engines configure their views through `modifyView`, whose implementations return a fresh
 * `props => <Component … />` on every call — and the platform re-applies that modification on every
 * `viewProvider(name)` call, which the region layouts make *during render*. React therefore sees a new
 * component type at the same position and remounts the whole view. For the Markdown editor that means the
 * Lexical composer is re-created from the saved markdown on every layout re-render — crossing the 768px
 * breakpoint, or merely opening a modal dialog — discarding cursor position, undo history and any open
 * editor dialog. The app only registers a `FormEngine` view modification since it started supplying
 * `formEngine.viewConfig` (see `appsetup.ts`), so this guard is needed from the same point on.
 *
 * Caching the modification's result is enough, because the providers themselves are already stable. Applied
 * to the *composed* config, since the features are what register the modifications.
 *
 * // TODO: Remove once A12-19155 is fixed; it is a no-op from then on.
 */
export function stabilizeModifications(configured: A12ApplicationConfig): A12ApplicationConfig {
    return {
        ...configured,
        config: {
            ...configured.config,
            viewModifications: cachePerName(configured.config.viewModifications),
            layoutModifications: cachePerName(configured.config.layoutModifications)
        }
    };
}
