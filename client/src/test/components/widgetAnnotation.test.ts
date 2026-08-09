import { describe, expect, it } from "vitest";

import { hasWidgetAnnotation } from "../../components/widgetAnnotation";

describe("hasWidgetAnnotation", () => {
    it("matches the requested widget annotation", () => {
        expect(hasWidgetAnnotation([{ name: "widget", value: "markdown-editor" }], "markdown-editor")).toBe(true);
    });

    it("matches among multiple annotations", () => {
        expect(
            hasWidgetAnnotation(
                [
                    { name: "roles", value: "admin" },
                    { name: "widget", value: "markdown-editor" }
                ],
                "markdown-editor"
            )
        ).toBe(true);
    });

    it("rejects other widget values", () => {
        expect(hasWidgetAnnotation([{ name: "widget", value: "fancy" }], "markdown-editor")).toBe(false);
    });

    it("rejects annotation without value", () => {
        expect(hasWidgetAnnotation([{ name: "widget" }], "markdown-editor")).toBe(false);
    });

    it("rejects undefined / empty annotations", () => {
        expect(hasWidgetAnnotation(undefined, "markdown-editor")).toBe(false);
        expect(hasWidgetAnnotation([], "markdown-editor")).toBe(false);
    });
});
