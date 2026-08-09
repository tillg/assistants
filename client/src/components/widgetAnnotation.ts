import type { Annotation } from "@com.mgmtp.a12.base/base-model-api";

export const WIDGET_ANNOTATION_NAME = "widget";

/** The `widget` annotation values for which the project provides a custom control. */
export type WidgetAnnotationValue = "markdown-editor";

/** True if a model element's annotations request the given widget (`widget: <value>`). */
export function hasWidgetAnnotation(
    annotations: readonly Annotation[] | undefined,
    value: WidgetAnnotationValue
): boolean {
    return getAnnotationValue(annotations, WIDGET_ANNOTATION_NAME) === value;
}

/** Reads the value of a named annotation, if present. */
export function getAnnotationValue(annotations: readonly Annotation[] | undefined, name: string): string | undefined {
    return annotations?.find((annotation) => annotation.name === name)?.value;
}
