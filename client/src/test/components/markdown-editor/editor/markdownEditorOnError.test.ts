import { describe, expect, it } from "vitest";

import { markdownEditorOnError } from "../../../../components/markdown-editor/editor/markdownEditorOnError";

describe("markdownEditorOnError", () => {
    it.each([
        "Lexical node does not exist in active editor state. Avoid using the same node references between nested closures from editorState.read/editor.update.",
        "Minified Lexical error #113; visit https://lexical.dev/docs/error?code=113 for the full message."
    ])("swallows the known stale-node race: %s", (message) => {
        expect(() => markdownEditorOnError(new Error(message))).not.toThrow();
    });

    it("rethrows any other editor error", () => {
        expect(() => markdownEditorOnError(new Error("Minified Lexical error #42"))).toThrow("#42");
        expect(() => markdownEditorOnError(new Error("something else broke"))).toThrow("something else broke");
    });
});
