import { CodeNode } from "@lexical/code";
import {
    BOLD_ITALIC_STAR,
    BOLD_ITALIC_UNDERSCORE,
    BOLD_STAR,
    BOLD_UNDERSCORE,
    CODE,
    HEADING,
    INLINE_CODE,
    ITALIC_STAR,
    ITALIC_UNDERSCORE,
    LINK,
    QUOTE,
    STRIKETHROUGH,
    type Transformer
} from "@lexical/markdown";
import { HorizontalRuleNode } from "@lexical/extension";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { TableCellNode, TableNode, TableRowNode } from "@lexical/table";
import { type Klass, type LexicalNode } from "lexical";

import { AdmonitionNode } from "../nodes/AdmonitionNode";
import { ImageNode } from "../nodes/ImageNode";
import { TocNode } from "../nodes/TocNode";

import { createAdmonitionTransformer } from "./admonitionTransformer";
import { createAlignTransformer } from "./alignmentTransformer";
import { COLOR } from "./colorTransformer";
import { HR } from "./horizontalRuleTransformer";
import { IMAGE } from "./imageTransformer";
import { CHECK_LIST_W12, ORDERED_LIST_W12, UNORDERED_LIST_W12 } from "./listTransformers";
import { createTableTransformer } from "./tableTransformer";
import { TOC } from "./tocTransformer";

// The table, admonition and alignment transformers need the full transformer set
// for their (cell / body / delegated-block) content; it is supplied lazily so
// those files need not depend on this registry.
const TABLE = createTableTransformer(() => MARKDOWN_TRANSFORMERS);
const ADMONITION = createAdmonitionTransformer(() => MARKDOWN_TRANSFORMERS);
const ALIGN = createAlignTransformer(() => MARKDOWN_TRANSFORMERS);

/**
 * Markdown feature set of the shared markdown editor (specs 006/007/008/009/024).
 * The project-maintained transformers live in dedicated files — TABLE
 * (tableTransformer), IMAGE (imageTransformer), HR (horizontalRuleTransformer),
 * the list family (listTransformers), the directive family ADMONITION/TOC/ALIGN
 * (admonitionTransformer/tocTransformer/alignmentTransformer) and the inline
 * text-color directive COLOR (colorTransformer); HIGHLIGHT stays out of scope.
 *
 * Order matters: ALIGN first so it is the first *multiline* transformer tried on
 * export (@lexical/markdown tries all multiline transformers before all element
 * transformers) and claims a format-bearing block ahead of CODE/ADMONITION/TABLE;
 * TABLE next so the table-row regexp wins over plain text; CHECK_LIST_W12 before
 * UNORDERED_LIST_W12 so `- [ ]` is not consumed as a bullet; ITALIC_UNDERSCORE
 * before ITALIC_STAR so emphasis exports as `_x_` (w12-free's remark canonical
 * form, bold stays `**` via BOLD_STAR); IMAGE before LINK so `![..](..)` is not
 * consumed as a link with a stray `!`. The directive transformers
 * (ALIGN/ADMONITION/TOC/COLOR) match disjoint node types and name-specific
 * patterns (`:::align` / `:::admonition` / `:::toc` / `:color[…]`), so their
 * placement is not order-sensitive for import.
 */
export const MARKDOWN_TRANSFORMERS: Transformer[] = [
    ALIGN,
    TABLE,
    HEADING,
    QUOTE,
    CODE,
    ADMONITION,
    TOC,
    HR,
    CHECK_LIST_W12,
    UNORDERED_LIST_W12,
    ORDERED_LIST_W12,
    BOLD_ITALIC_STAR,
    BOLD_ITALIC_UNDERSCORE,
    BOLD_STAR,
    BOLD_UNDERSCORE,
    ITALIC_UNDERSCORE,
    ITALIC_STAR,
    STRIKETHROUGH,
    INLINE_CODE,
    COLOR,
    IMAGE,
    LINK
];

/**
 * Nodes required by MARKDOWN_TRANSFORMERS that are NOT registered by the A12
 * DefaultRichTextEditor wrapper. The wrapper registers list nodes (base editor
 * config) and LinkNode/AutoLinkNode (wrapper initialConfig); a bare RichTextEditor
 * or headless editor must register those separately.
 */
export const MARKDOWN_NODES: Klass<LexicalNode>[] = [
    HeadingNode,
    QuoteNode,
    CodeNode,
    TableNode,
    TableRowNode,
    TableCellNode,
    ImageNode,
    HorizontalRuleNode,
    AdmonitionNode,
    TocNode
];
