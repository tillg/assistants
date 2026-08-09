import { describe, expect, it } from "vitest";

import { buildTocTree, slugify, type HeadingItem } from "../../../../components/markdown-editor/nodes/tocTree";

function heading(level: number, text: string): HeadingItem {
    return { level, text, slug: slugify(text), nodeKey: `${level}-${text}` };
}

describe("slugify", () => {
    it("lowercases, replaces non-alphanumerics, and trims dashes", () => {
        expect(slugify("Hello World")).toBe("hello-world");
        expect(slugify("  Spaced & Punctuated!  ")).toBe("spaced-punctuated");
        expect(slugify("Already-slug_2")).toBe("already-slug-2");
    });
});

describe("buildTocTree", () => {
    it("nests headings by level", () => {
        const tree = buildTocTree([heading(1, "A"), heading(2, "A.1"), heading(2, "A.2"), heading(1, "B")]);
        expect(tree).toHaveLength(2);
        expect(tree[0]?.text).toBe("A");
        expect(tree[0]?.children.map((c) => c.text)).toEqual(["A.1", "A.2"]);
        expect(tree[1]?.text).toBe("B");
    });

    it("keeps skipped levels compact (h1 → h3 nests at depth 2)", () => {
        const tree = buildTocTree([heading(1, "A"), heading(3, "deep")]);
        expect(tree).toHaveLength(1);
        expect(tree[0]?.children).toHaveLength(1);
        expect(tree[0]?.children[0]?.text).toBe("deep");
        expect(tree[0]?.children[0]?.children).toHaveLength(0);
    });

    it("treats a heading deeper than all predecessors as a new root sibling", () => {
        const tree = buildTocTree([heading(3, "first"), heading(1, "second")]);
        expect(tree.map((n) => n.text)).toEqual(["first", "second"]);
    });
});
