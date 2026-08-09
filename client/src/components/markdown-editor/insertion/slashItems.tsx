import { $createCodeNode } from "@lexical/code";
import { MenuOption } from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { $createHeadingNode, $createQuoteNode, type HeadingTagType } from "@lexical/rich-text";
import { $setBlocksType } from "@lexical/selection";
import { $getSelection, $isRangeSelection, type LexicalEditor } from "lexical";
import type { ReactNode } from "react";

import { Icon } from "@com.mgmtp.a12.widgets/widgets-core";

import { type Localize, RESOURCE_KEYS } from "../../../localization";

import { insertableItems } from "./insertionRegistry";
import { $toggleList, LIST_ITEMS } from "./listItems";

/**
 * One entry in the `/` slash command menu. `run` is invoked inside an editor update
 * (the plugin has already removed the `/query` text), so block-type items call the
 * `$` transforms directly and insertable items dispatch their registry command.
 */
export class SlashOption extends MenuOption {
    constructor(
        key: string,
        // `title` overrides MenuOption's (0.44 added an optional `title?: JSX.Element | string`); `iconNode`
        // deliberately does NOT reuse the base `icon?: JSX.Element` slot — the palette renders via a custom
        // menuRenderFn (not Lexical's default) and stores an arbitrary ReactNode, wider than JSX.Element.
        override readonly title: string,
        readonly iconNode: ReactNode,
        readonly keywords: readonly string[],
        readonly run: (editor: LexicalEditor) => void,
        /** Mousetrap-style binding shown as a hint in the palette (registry items only). */
        readonly shortcut?: string
    ) {
        super(key);
    }
}

const outlined = (name: string): ReactNode => <Icon iconTheme="outlined">{name}</Icon>;

function headingOption(level: 1 | 2 | 3 | 4 | 5 | 6, localize?: Localize): SlashOption {
    const tag = `h${level}` as HeadingTagType;
    const title = localize
        ? localize(RESOURCE_KEYS.markdownEditor.block.heading, { level: { type: "plain", value: level } })
        : `Heading ${level}`;
    return new SlashOption(
        `core:${tag}`,
        title,
        outlined("format_size"),
        ["heading", tag, `heading ${level}`, "title"],
        () => {
            const selection = $getSelection();
            if ($isRangeSelection(selection)) {
                $setBlocksType(selection, () => $createHeadingNode(tag));
            }
        }
    );
}

/**
 * Core block-type / list items — the block transforms that are not registry insertables
 * (they change the current block rather than insert a node). Merged with the registry
 * items so the palette offers headings/quote/code/lists alongside tables, panels, etc.
 */
function coreSlashOptions(localize?: Localize): SlashOption[] {
    // Localized label, or the English fallback when no localizer is supplied (e.g. the shortcut binder).
    const label = (key: string, fallback: string): string => (localize ? localize(key) : fallback);
    return [
        headingOption(1, localize),
        headingOption(2, localize),
        headingOption(3, localize),
        headingOption(4, localize),
        headingOption(5, localize),
        headingOption(6, localize),
        new SlashOption(
            "core:quote",
            label(RESOURCE_KEYS.markdownEditor.block.quote, "Quote"),
            outlined("format_quote"),
            ["quote", "blockquote", "citation"],
            () => {
                const selection = $getSelection();
                if ($isRangeSelection(selection)) {
                    $setBlocksType(selection, () => $createQuoteNode());
                }
            }
        ),
        new SlashOption(
            "core:code",
            label(RESOURCE_KEYS.markdownEditor.block.code, "Code block"),
            outlined("code"),
            ["code", "codeblock", "fenced", "pre"],
            () => {
                const selection = $getSelection();
                if ($isRangeSelection(selection)) {
                    $setBlocksType(selection, () => $createCodeNode());
                }
            }
        ),
        // Lists come from the shared LIST_ITEMS source (toggle-aware; also drive the toolbar buttons).
        ...LIST_ITEMS.map(
            (def) =>
                new SlashOption(
                    def.key,
                    label(def.labelKey, def.displayName),
                    def.icon,
                    def.keywords,
                    (editor) => $toggleList(editor, def),
                    def.keyboardShortcut
                )
        )
    ];
}

/**
 * The full slash palette: core block items followed by the registry's slash-enabled insertables.
 * Pass a localizer to render localized titles; omit it (shortcut binder / tests) for English fallbacks.
 */
export function slashOptions(localize?: Localize): SlashOption[] {
    const registryOptions = insertableItems()
        .filter((item) => item.surfaces.slashMenu)
        .map(
            (item) =>
                new SlashOption(
                    item.key,
                    localize ? localize(item.labelKey) : item.displayName,
                    item.icon,
                    item.slashKeywords,
                    item.insert,
                    // Only advertise/bind the shortcut when the item opts into that surface.
                    item.surfaces.shortcut ? item.keyboardShortcut : undefined
                )
        );
    return [...coreSlashOptions(localize), ...registryOptions];
}

/** Case-insensitive substring match over title + keywords; empty query returns everything. */
export function filterSlashOptions(options: readonly SlashOption[], query: string | null): SlashOption[] {
    if (query === null || query === "") {
        return [...options];
    }
    const needle = query.toLowerCase();
    return options.filter(
        (option) =>
            option.title.toLowerCase().includes(needle) ||
            option.keywords.some((keyword) => keyword.toLowerCase().includes(needle))
    );
}
