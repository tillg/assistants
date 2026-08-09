import { describe, expect, it } from "vitest";

import { isBlockedUrl } from "../../../components/markdown-editor/urlSafety";

describe("isBlockedUrl", () => {
    it.each([
        "javascript:alert(1)",
        "JavaScript:alert(1)",
        "  javascript:alert(1)",
        "java\tscript:alert(1)",
        "\njavascript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "DATA:image/svg+xml;base64,PHN2Zz4="
    ])("blocks %j", (url) => {
        expect(isBlockedUrl(url)).toBe(true);
    });

    it.each([
        "https://example.com",
        "http://example.com/a/b?c=d",
        "mailto:a@b.com",
        "/relative/path",
        "./image.png",
        "attachment:7f3a9c21",
        "ftp://example.com/file"
    ])("allows %j", (url) => {
        expect(isBlockedUrl(url)).toBe(false);
    });
});
