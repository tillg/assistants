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

import type { PropsWithChildren, ReactElement } from "react";
import { useMemo } from "react";
import { useSelector } from "react-redux";
import { StyleSheetManager, ThemeProvider } from "styled-components";
import { DndProvider } from "react-dnd";

import { ApplicationSelectors, ViewViews } from "@com.mgmtp.a12.client/client-core";
import {
    GlobalStyles,
    DragAndDropUtils,
    SizeContext,
    useWindowSize,
    shouldForwardProp
} from "@com.mgmtp.a12.widgets/widgets-core";

import { MarkdownEditorGlobalStyles } from "../../components/markdown-editor/theme/editorTheme";

import { ThemeContextProvider, THEMES, useThemeContext } from "../ThemeContext";

/**
 * Base application page providing UI infrastructure: size context, drag-and-drop, notifications, and progress indicator.
 */
const BasePage = ({ children }: PropsWithChildren): ReactElement => {
    const { breakPoint } = useWindowSize();
    const busyState = useSelector(ApplicationSelectors.busy());
    const sizeContextValue = useMemo(() => ({ currentSize: breakPoint.size }), [breakPoint.size]);

    return (
        <SizeContext.Provider value={sizeContextValue}>
            <DndProvider
                backend={DragAndDropUtils.DefaultDndBackend}
                options={DragAndDropUtils.DefaultDndBackendOptions}>
                <ViewViews.ProgressIndicator progress={busyState ? "loading" : "none"} global>
                    {children}
                </ViewViews.ProgressIndicator>
            </DndProvider>
        </SizeContext.Provider>
    );
};

const ThemedPageWrapper = ({ children }: PropsWithChildren) => {
    const theme = useThemeContext((context) => context.theme);
    return (
        <StyleSheetManager shouldForwardProp={shouldForwardProp}>
            <ThemeProvider theme={THEMES[theme] ?? THEMES.Base}>
                <GlobalStyles />
                <MarkdownEditorGlobalStyles />
                <BasePage>{children}</BasePage>
            </ThemeProvider>
        </StyleSheetManager>
    );
};

/**
 * Page with global styles and base theme applied.
 *
 * Other available themes can be found in the Widgets documentation.
 */
export const StyledPage = ({ children }: PropsWithChildren): ReactElement => {
    return (
        <ThemeContextProvider>
            <ThemedPageWrapper>{children}</ThemedPageWrapper>
        </ThemeContextProvider>
    );
};
