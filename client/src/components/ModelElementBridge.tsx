import { createContext, type ComponentType } from "react";

import type { FormModel } from "@com.mgmtp.a12.formengine/formengine-core";

/**
 * Exposes the current annotated model element to widgets rendered beneath it — a `Control`, or the
 * `FieldOverviewColumn` of an inline repeat. Widget props don't carry annotations, so widgets read them from here
 * (e.g. `widget: markdown-editor` / `wql-editor`).
 */
export const ModelElementContext = createContext<FormModel.Annotated | undefined>(undefined);

/** The formModelMap-component props the bridge needs: an annotated `modelElement`, plus whatever else it carries. */
interface AnnotatedModelProps {
    readonly modelElement: FormModel.Annotated;
}

/**
 * Creates a formModelMap replacement for an annotated model element that bridges its model into
 * {@link ModelElementContext}, then delegates rendering to the given component (inject the previously configured
 * one so its behavior is preserved). Used for both the `Control` slot and the `FieldOverviewColumn` slot — the
 * latter so an inline-repeat cell's column annotations reach the widget it renders. Generic over the full props so
 * component-specific extras (e.g. the column's `repeat`/`alignment`) pass through untouched.
 */
export function createModelElementBridge<P extends AnnotatedModelProps>(Delegate: ComponentType<P>): ComponentType<P> {
    return function ModelElementBridge(props) {
        return (
            <ModelElementContext.Provider value={props.modelElement}>
                <Delegate {...props} />
            </ModelElementContext.Provider>
        );
    };
}
