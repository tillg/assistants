import {
    $applyNodeReplacement,
    DecoratorNode,
    type DOMConversionMap,
    type EditorConfig,
    type LexicalNode,
    type NodeKey,
    type SerializedLexicalNode,
    type Spread
} from "lexical";
import type { ReactElement } from "react";

import { isBlockedUrl } from "../urlSafety";

export interface ImagePayload {
    src: string;
    altText: string;
    key?: NodeKey;
}

export type SerializedImageNode = Spread<{ src: string; altText: string }, SerializedLexicalNode>;

/**
 * Inline image: renders an <img>, serializes as ![alt](src). The src is an
 * external URL and renders directly (broken URLs degrade to the browser's
 * alt-text behavior). No upload/resizing/captions.
 *
 * Adapted from the Lexical playground ImageNode (v0.31.2), stripped to the
 * minimal feature set; project-maintained — re-check against the playground
 * on Lexical upgrades.
 */
export class ImageNode extends DecoratorNode<ReactElement> {
    __src: string;
    __altText: string;

    static override getType(): string {
        return "image";
    }

    static override clone(node: ImageNode): ImageNode {
        return new ImageNode(node.__src, node.__altText, node.__key);
    }

    static override importJSON(serializedNode: SerializedImageNode): ImageNode {
        return $createImageNode({ src: serializedNode.src, altText: serializedNode.altText });
    }

    constructor(src: string, altText: string, key?: NodeKey) {
        super(key);
        this.__src = src;
        this.__altText = altText;
    }

    // super.exportJSON() provides `type` and `version` (Lexical 0.31 contract,
    // same pattern as LinkNode).
    override exportJSON(): SerializedImageNode {
        return {
            ...super.exportJSON(),
            src: this.__src,
            altText: this.__altText
        };
    }

    getSrc(): string {
        return this.getLatest().__src;
    }

    getAltText(): string {
        return this.getLatest().__altText;
    }

    override createDOM(config: EditorConfig): HTMLElement {
        const span = document.createElement("span");
        const className = config.theme.image;
        if (className !== undefined) {
            span.className = className;
        }
        return span;
    }

    override updateDOM(): false {
        return false;
    }

    // HTML <img> paste conversion deliberately disabled until URL sanitization lands.
    static override importDOM(): DOMConversionMap | null {
        return null;
    }

    override decorate(): ReactElement {
        // javascript:/data: srcs are never loaded (spec 008); fall back to alt text.
        if (isBlockedUrl(this.__src)) {
            return <span>{this.__altText}</span>;
        }
        return <img src={this.__src} alt={this.__altText} draggable="false" />;
    }
}

export function $createImageNode({ src, altText, key }: ImagePayload): ImageNode {
    return $applyNodeReplacement(new ImageNode(src, altText, key));
}

export function $isImageNode(node: LexicalNode | null | undefined): node is ImageNode {
    return node instanceof ImageNode;
}
