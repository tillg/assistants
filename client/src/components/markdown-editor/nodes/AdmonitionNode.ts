import {
    $applyNodeReplacement,
    ElementNode,
    type DOMConversionMap,
    type EditorConfig,
    type ElementDOMSlot,
    type LexicalNode,
    type NodeKey,
    type SerializedElementNode,
    type Spread
} from "lexical";

/** User-facing admonition variants offered by the insertion UI. */
export const ADMONITION_VARIANTS = ["info", "warning", "note", "tip", "panel"] as const;
export type AdmonitionVariant = (typeof ADMONITION_VARIANTS)[number];

export type SerializedAdmonitionNode = Spread<{ admonitionType: string }, SerializedElementNode>;

/**
 * Title-row icon (Material Symbols Outlined ligature) and label per variant. The
 * raw `type` string round-trips verbatim, so w12-free-authored or unknown types
 * fall back to a neutral panel; per-type container colors live in the editor CSS.
 */
const ADMONITION_CHROME: Record<string, { icon: string; label: string }> = {
    info: { icon: "info", label: "Info" },
    warning: { icon: "warning", label: "Warning" },
    note: { icon: "edit", label: "Note" },
    tip: { icon: "lightbulb", label: "Tip" },
    panel: { icon: "web_asset", label: "Panel" },
    missing: { icon: "block", label: "Missing" }
};
const DEFAULT_ADMONITION_CHROME = { icon: "web_asset", label: "Panel" };

export function admonitionChrome(type: string): { icon: string; label: string } {
    return ADMONITION_CHROME[type] ?? DEFAULT_ADMONITION_CHROME;
}

/** Set the icon ligature + label on an existing header's two child spans. */
function applyAdmonitionChrome(header: Element, type: string): void {
    const { icon, label } = admonitionChrome(type);
    const [iconEl, labelEl] = header.children;
    if (iconEl) {
        iconEl.textContent = icon;
    }
    if (labelEl) {
        labelEl.textContent = label;
    }
}

/**
 * Build the non-editable title row (icon glyph + variant label). It is
 * `contenteditable="false"` so the caret can't land in it, and lives outside the
 * node's managed-children region (see {@link AdmonitionNode.getDOMSlot}); the
 * markdown serializer walks child nodes, not DOM, so it never leaks into output.
 * The icon span uses the Material Symbols Outlined font — the same glyphs the
 * toolbar renders via the A12 `Icon` widget (styled in the editor CSS).
 */
function createAdmonitionHeader(type: string): HTMLElement {
    const header = document.createElement("div");
    header.className = "md-editor-admonition-header";
    header.contentEditable = "false";
    const iconEl = document.createElement("span");
    iconEl.className = "md-editor-admonition-icon";
    iconEl.setAttribute("aria-hidden", "true");
    header.append(iconEl, document.createElement("span"));
    applyAdmonitionChrome(header, type);
    return header;
}

/**
 * Admonition (callout panel) — a `:::admonition{type="…"}` container directive.
 * Extends `ElementNode`: its children are the editable body (paragraphs, inline
 * marks, lists). The container is type-colored via CSS keyed on the
 * `data-admonition-type` attribute; the title row is a non-editable header
 * element prepended in {@link createDOM} (real icons, not Unicode glyphs), with
 * the editable body inserted after it via {@link getDOMSlot}.
 */
export class AdmonitionNode extends ElementNode {
    __admonitionType: string;

    static override getType(): string {
        return "admonition";
    }

    static override clone(node: AdmonitionNode): AdmonitionNode {
        return new AdmonitionNode(node.__admonitionType, node.__key);
    }

    static override importJSON(serializedNode: SerializedAdmonitionNode): AdmonitionNode {
        return $createAdmonitionNode(serializedNode.admonitionType);
    }

    constructor(admonitionType: string, key?: NodeKey) {
        super(key);
        this.__admonitionType = admonitionType;
    }

    override exportJSON(): SerializedAdmonitionNode {
        return {
            ...super.exportJSON(),
            admonitionType: this.__admonitionType
        };
    }

    getAdmonitionType(): string {
        return this.getLatest().__admonitionType;
    }

    setAdmonitionType(admonitionType: string): void {
        this.getWritable().__admonitionType = admonitionType;
    }

    override createDOM(config: EditorConfig): HTMLElement {
        const div = document.createElement("div");
        const className = config.theme.admonition;
        if (typeof className === "string") {
            div.className = className;
        }
        div.setAttribute("data-admonition-type", this.__admonitionType);
        div.appendChild(createAdmonitionHeader(this.__admonitionType));
        return div;
    }

    // The editable body is inserted after the (non-editable) header, so the header
    // stays put as the title row and is never treated as a managed child node.
    override getDOMSlot(element: HTMLElement): ElementDOMSlot {
        const header = element.firstElementChild;
        const slot = super.getDOMSlot(element);
        return header ? slot.withAfter(header) : slot;
    }

    override updateDOM(prevNode: AdmonitionNode, dom: HTMLElement): boolean {
        if (prevNode.__admonitionType !== this.__admonitionType) {
            dom.setAttribute("data-admonition-type", this.__admonitionType);
            const header = dom.firstElementChild;
            if (header) {
                applyAdmonitionChrome(header, this.__admonitionType);
            }
        }
        return false;
    }

    // HTML paste conversion is out of scope; directives arrive via markdown only.
    static override importDOM(): DOMConversionMap | null {
        return null;
    }
}

export function $createAdmonitionNode(admonitionType: string): AdmonitionNode {
    return $applyNodeReplacement(new AdmonitionNode(admonitionType));
}

export function $isAdmonitionNode(node: LexicalNode | null | undefined): node is AdmonitionNode {
    return node instanceof AdmonitionNode;
}
