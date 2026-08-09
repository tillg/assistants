import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { LexicalTypeaheadMenuPlugin, useBasicTypeaheadTriggerMatch } from "@lexical/react/LexicalTypeaheadMenuPlugin";
import type { TextNode } from "lexical";
import { useCallback, useMemo, useState } from "react";
import styled from "styled-components";

import { AttachedPortal, List } from "@com.mgmtp.a12.widgets/widgets-core";

import { useLocalizer } from "../../../localization";

import { formatShortcut, isMacPlatform } from "../insertion/shortcuts";
import { filterSlashOptions, SlashOption, slashOptions } from "../insertion/slashItems";

const IS_MAC = isMacPlatform();

/**
 * The caret rectangle used to anchor the palette, passed to `AttachedPortal` as `referenceElementRect`.
 *
 * Two problems this solves, both only on the first open:
 *  - `AttachedPortal.shouldShow()` hides itself when its reference isn't the topmost element at its own
 *    position (`isNotFullyOverlapped`) — which Lexical's invisible zero-area caret marker never is — so
 *    the palette mounts with no children (`isReferenceElementVisible: false`). An explicit rect with a
 *    non-zero width takes `shouldShow`'s documented "reference is overlapped" escape hatch.
 *  - Lexical positions its marker in a post-render effect, so at render the marker still sits at (0,0),
 *    and `AttachedPortal` never re-measures the out-of-tree marker afterwards — the palette would open in
 *    the corner. The live DOM selection already holds the real caret box, so anchor to that instead.
 */
function caretRect(anchor: HTMLElement): DOMRect {
    const selection = anchor.ownerDocument.defaultView?.getSelection();
    const rect =
        selection && selection.rangeCount > 0
            ? selection.getRangeAt(0).getBoundingClientRect()
            : anchor.getBoundingClientRect();
    return new DOMRect(rect.x, rect.y, Math.max(rect.width, 1), Math.max(rect.height, 1));
}

/**
 * Compact slash-menu row. A12 `List.Item` is spaced for touch; trim the content
 * wrapper's min-height and vertical padding for a denser desktop palette. `&` is the
 * item's `<li>`; `& > div` is its content wrapper. Horizontal padding is left to the theme.
 */
const CompactSlashItem = styled(List.Item)`
    & > div {
        min-height: 0;
        padding-top: 4px;
        padding-bottom: 4px;
    }
`;

/**
 * The `/` slash command menu. Typing `/` at a block/word boundary opens a floating
 * palette near the caret; filtering, arrow/Enter/Esc navigation and removal of the
 * `/query` text are handled by Lexical's typeahead plugin. Every option is derived
 * from the same source as the toolbar (core block items + the insertion registry),
 * so the two surfaces cannot drift.
 *
 * The palette is built entirely from A12 widgets — `AttachedPortal` (viewport-aware
 * placement + portalling) wrapping a `List` of `List.Item`s (icon / label / shortcut
 * via the graphic / text / meta slots) — rather than hand-rolled DOM.
 */
export function SlashCommandPlugin() {
    const [editor] = useLexicalComposerContext();
    const localize = useLocalizer();
    const [query, setQuery] = useState<string | null>(null);

    // `/` at the start of a line or after whitespace; empty query (minLength 0) opens the full list.
    const triggerFn = useBasicTypeaheadTriggerMatch("/", { minLength: 0 });

    const options = useMemo(() => slashOptions(localize), [localize]);
    const filtered = useMemo(() => filterSlashOptions(options, query), [options, query]);

    const onSelectOption = useCallback(
        (option: SlashOption, nodeToRemove: TextNode | null, closeMenu: () => void) => {
            editor.update(() => {
                // Drop the literal `/query`, then run the option against the resulting caret.
                nodeToRemove?.remove();
                option.run(editor);
            });
            closeMenu();
        },
        [editor]
    );

    return (
        <LexicalTypeaheadMenuPlugin<SlashOption>
            onQueryChange={setQuery}
            onSelectOption={onSelectOption}
            triggerFn={triggerFn}
            options={filtered}
            menuRenderFn={(anchorElementRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) => {
                const anchor = anchorElementRef.current;
                if (anchor === null || filtered.length === 0) {
                    return null;
                }
                return (
                    <AttachedPortal
                        referenceElement={anchor}
                        referenceElementRect={caretRect(anchor)}
                        orientation="bottom-start"
                        orientationList={["bottom-start", "top-start"]}
                        // Positioning + portalling only — the typeahead plugin owns focus and open/close.
                        focusOnOpen={false}
                        closeOnEsc={false}
                        closeOnOutsideClick={false}
                        closeOnClickReferenceElement={false}>
                        <List role="listbox" style={{ minWidth: 220, maxHeight: 320, overflowY: "auto" }}>
                            {filtered.map((option, index) => (
                                <CompactSlashItem
                                    key={option.key}
                                    wrapperRef={(element) => option.setRefElement(element)}
                                    graphic={option.iconNode}
                                    text={option.title}
                                    meta={
                                        option.shortcut === undefined
                                            ? undefined
                                            : formatShortcut(option.shortcut, IS_MAC)
                                    }
                                    active={index === selectedIndex}
                                    // Keep the editor selection so the insert targets the trigger block.
                                    onMouseDown={(event) => event?.preventDefault()}
                                    onMouseEnter={() => setHighlightedIndex(index)}
                                    onClick={() => {
                                        setHighlightedIndex(index);
                                        selectOptionAndCleanUp(option);
                                    }}
                                />
                            ))}
                        </List>
                    </AttachedPortal>
                );
            }}
        />
    );
}
