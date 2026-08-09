/**
 * Pure heading-hierarchy logic for the TOC directive (spec 009). Ported from
 * w12-free's `tocTree.ts` (level-folding with compact skipped levels). Kept
 * React-free and pure so it is unit-testable on its own; {@link TocNode}'s view
 * renders the tree this produces as nested `<ol>`.
 */

export interface HeadingItem {
    readonly level: number;
    readonly text: string;
    readonly slug: string;
    /** Lexical node key of the source heading — used to scroll to it on click. */
    readonly nodeKey: string;
}

/** A heading with its descendant headings nested underneath. */
export interface TocTreeNode extends HeadingItem {
    /** Stable React key derived from source order + slug. */
    readonly key: string;
    readonly children: TocTreeNode[];
}

/** Lowercase, non-alphanumeric → `-`, collapse runs, trim leading/trailing `-`. */
export function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

/**
 * Fold the flat, document-ordered heading list into a hierarchy by level. A
 * heading nests under the nearest preceding heading with a strictly smaller
 * level; skipped levels stay COMPACT (h1 → h3 makes the h3 a direct child of
 * the h1, not a padded depth-3 entry). A heading deeper than everything before
 * it becomes a new root sibling. The nesting lets CSS counters render
 * hierarchical section numbers (1, 1.1, 1.2.1, 2).
 */
export function buildTocTree(items: readonly HeadingItem[]): TocTreeNode[] {
    const root: TocTreeNode[] = [];
    const ancestors: TocTreeNode[] = [];
    items.forEach((item, idx) => {
        const node: TocTreeNode = { ...item, key: `${idx}-${item.slug}`, children: [] };
        let parent = ancestors.at(-1);
        while (parent !== undefined && parent.level >= item.level) {
            ancestors.pop();
            parent = ancestors.at(-1);
        }
        if (parent === undefined) {
            root.push(node);
        } else {
            parent.children.push(node);
        }
        ancestors.push(node);
    });
    return root;
}
