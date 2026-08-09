import { createHeadlessEditor } from "@lexical/headless";
import { AutoLinkNode, LinkNode } from "@lexical/link";
import { $createParagraphNode, $createTextNode, $getRoot, type LexicalEditor } from "lexical";

import { EditorNodes } from "@com.mgmtp.a12.widgets/widgets-core";

import { $markdownToNodes, $nodesToMarkdown } from "../../../components/markdown-editor/markdown/markdownConversion";
import { MARKDOWN_NODES } from "../../../components/markdown-editor/markdown/markdownTransformers";

/**
 * Headless editor matching the production node graph: MARKDOWN_NODES plus the nodes the A12
 * DefaultRichTextEditor wrapper registers itself. EditorNodes carries widgets-core's custom
 * ListItemNode/InlineStyleTextNode and their node-replacements for the stock @lexical/list
 * ListItemNode and TextNode, so list/text round-trip tests exercise the same node graph as
 * the real editor rather than the stock @lexical nodes.
 */
export function createTestEditor(): LexicalEditor {
    return createHeadlessEditor({
        namespace: "test",
        nodes: [...MARKDOWN_NODES, ...(EditorNodes ?? []), LinkNode, AutoLinkNode],
        onError: (error) => {
            throw error;
        }
    });
}

/**
 * markdown → Lexical nodes → markdown, through the editor's real conversion
 * pipeline, on a headless editor with the full markdown node set.
 */
export function roundTrip(markdown: string): string {
    const editor = createTestEditor();
    editor.update(() => $markdownToNodes(markdown), { discrete: true });
    let result = "";
    editor.getEditorState().read(() => {
        result = $nodesToMarkdown();
    });
    return result;
}

// Runs an Enter-conversion fn in a discrete update (which retains the new node)
// and returns the resulting top-level node types. The live KEY_ENTER *dispatch*
// can't be exercised headless: with no DOM, a non-discrete update that replaces
// the selected block drops the new node — true for both the HorizontalRuleNode
// (a decorator) and the CodeNode (an element). It's a headless artifact, not a
// logic bug (Lexical 0.46's identical Enter code behaves the same way here yet
// works in the browser), so the real Enter path is covered by manual smoke.
export function convertOnEnter(lineText: string, convert: () => boolean): { converted: boolean; types: string[] } {
    const editor = createTestEditor();
    let converted = false;
    editor.update(
        () => {
            const root = $getRoot();
            root.clear();
            const paragraph = $createParagraphNode();
            paragraph.append($createTextNode(lineText));
            root.append(paragraph);
            paragraph.selectEnd();
            converted = convert();
        },
        { discrete: true }
    );
    let types: string[] = [];
    editor.getEditorState().read(() => {
        types = $getRoot()
            .getChildren()
            .map((child) => child.getType());
    });
    return { converted, types };
}
