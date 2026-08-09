import { $createHeadingNode } from "@lexical/rich-text";
import { $createParagraphNode, $createTextNode, $getRoot, type ElementFormatType } from "lexical";
import { describe, expect, it } from "vitest";

import { $createAdmonitionNode } from "../../../../components/markdown-editor/nodes/AdmonitionNode";
import { $nodesToMarkdown } from "../../../../components/markdown-editor/markdown/markdownConversion";

import { createTestEditor, roundTrip } from "../markdownTestUtils";

/** Build a node graph on a headless editor and serialize it to markdown. */
function serialize(build: () => void): string {
    const editor = createTestEditor();
    editor.update(build, { discrete: true });
    let markdown = "";
    editor.getEditorState().read(() => {
        markdown = $nodesToMarkdown();
    });
    return markdown;
}

describe("alignment directive round-trip", () => {
    it.each(["center", "right", "justify"])("round-trips a %s-aligned paragraph", (to) => {
        const md = `:::align{to="${to}"}\nAligned paragraph.\n:::`;
        expect(roundTrip(md)).toBe(md);
    });

    it("round-trips a centered heading (delegates to the heading transformer, keeping #)", () => {
        const md = ':::align{to="center"}\n## Section title\n:::';
        expect(roundTrip(md)).toBe(md);
    });

    it("round-trips a centered bullet list", () => {
        const md = ':::align{to="center"}\n- first item\n- second item\n:::';
        expect(roundTrip(md)).toBe(md);
    });

    it("round-trips a right-aligned quote", () => {
        const md = ':::align{to="right"}\n> Quoted line\n:::';
        expect(roundTrip(md)).toBe(md);
    });

    it("round-trips inline marks inside an aligned paragraph", () => {
        const md = ':::align{to="center"}\nText with **bold** and a [link](https://example.com).\n:::';
        expect(roundTrip(md)).toBe(md);
    });

    it("round-trips an aligned block surrounded by prose", () => {
        const md = '# Title\n\nIntro paragraph.\n\n:::align{to="right"}\nAligned callout.\n:::\n\nOutro paragraph.';
        expect(roundTrip(md)).toBe(md);
    });
});

describe("alignment format bit → directive (export)", () => {
    it.each(["center", "right", "justify"] as const)("wraps a %s-formatted paragraph", (to) => {
        const md = serialize(() => {
            const root = $getRoot();
            root.clear();
            const paragraph = $createParagraphNode();
            paragraph.append($createTextNode("Aligned paragraph."));
            paragraph.setFormat(to);
            root.append(paragraph);
        });
        expect(md).toBe(`:::align{to="${to}"}\nAligned paragraph.\n:::`);
    });

    it("wraps a right-formatted heading keeping its markdown prefix", () => {
        const md = serialize(() => {
            const root = $getRoot();
            root.clear();
            const heading = $createHeadingNode("h2");
            heading.append($createTextNode("Section title"));
            heading.setFormat("right");
            root.append(heading);
        });
        expect(md).toBe(':::align{to="right"}\n## Section title\n:::');
    });

    it.each(["", "left"] as ElementFormatType[])("emits no directive for %j (default)", (format) => {
        const md = serialize(() => {
            const root = $getRoot();
            root.clear();
            const paragraph = $createParagraphNode();
            paragraph.append($createTextNode("Default paragraph."));
            paragraph.setFormat(format);
            root.append(paragraph);
        });
        expect(md).toBe("Default paragraph.");
    });

    it("does not wrap an aligned container directive (keeps markdown valid)", () => {
        // A centered admonition would nest `:::` fences, which the matcher cannot
        // round-trip; the guard serializes it un-aligned instead.
        const md = serialize(() => {
            const root = $getRoot();
            root.clear();
            const admonition = $createAdmonitionNode("info");
            const body = $createParagraphNode();
            body.append($createTextNode("Panel body."));
            admonition.append(body);
            admonition.setFormat("center");
            root.append(admonition);
        });
        expect(md).toBe(':::admonition{type="info"}\nPanel body.\n:::');
        expect(md).not.toContain(":::align");
    });
});

describe("alignment degrade / canonicalization", () => {
    it("preserves an unknown alignment value verbatim as plain text", () => {
        const md = ':::align{to="middle"}\nText.\n:::';
        // `to="middle"` is not one of the four valid values → matches no
        // transformer and survives as plain text (spec 009 degrade-for-free).
        expect(roundTrip(md)).toBe(md);
    });

    it("treats an explicit left as a no-op reset (directive canonicalized away)", () => {
        const md = ':::align{to="left"}\nLeft text.\n:::';
        expect(roundTrip(md)).toBe("Left text.");
    });

    it("degrades an unclosed alignment directive to plain text (no data loss)", () => {
        const md = ':::align{to="center"}\nNo closing fence here.';
        expect(roundTrip(md)).toContain("No closing fence here.");
        expect(roundTrip(md)).toContain(':::align{to="center"}');
    });

    it("is cycle-2 stable for a multi-line body (canonicalized to one directive per block)", () => {
        const md = ':::align{to="center"}\nFirst line.\nSecond line.\n:::';
        const once = roundTrip(md);
        expect(roundTrip(once)).toBe(once);
    });
});
