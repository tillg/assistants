import type { PropsWithChildren } from "react";
import { Provider } from "react-redux";
import { ThemeProvider } from "styled-components";
import type { Store } from "redux";

import { getBaseTheme } from "@com.mgmtp.a12.widgets/widgets-core";

/**
 * The two providers the Transcript's components need to render: the A12 widget theme, because every
 * colour comes from it, and a store, because a navigation is a dispatch. Neither is stubbed out with a
 * fake — the theme is the real one and the store records what was dispatched, which is the assertion.
 *
 * This file deliberately imports nothing from `@testing-library/react`: it would be the only
 * non-`*.test.*` file allowed to reach for a devDependency, and it does not need to.
 */

/** A store that does nothing but remember what it was asked to do. */
export function recordingStore(): { readonly actions: unknown[]; readonly store: Store } {
    const actions: unknown[] = [];
    const store = {
        getState: () => ({}),
        dispatch: (action: unknown) => {
            actions.push(action);
            return action;
        },
        subscribe: () => () => {},
        replaceReducer: () => {}
    };
    return { actions, store: store as unknown as Store };
}

/** Wraps a component in the theme and the store it is rendered under in the application. */
export function Frame({ store, children }: PropsWithChildren<{ readonly store?: Store }>) {
    return (
        <Provider store={store ?? recordingStore().store}>
            <ThemeProvider theme={getBaseTheme()}>{children}</ThemeProvider>
        </Provider>
    );
}
