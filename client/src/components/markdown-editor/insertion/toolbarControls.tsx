import {
    createBlockButton,
    createButtonGroup,
    Icon,
    type ButtonType,
    type StaticToolbarProps
} from "@com.mgmtp.a12.widgets/widgets-core";

import { type Localize, RESOURCE_KEYS } from "../../../localization";

import { INSERT_EXTENSIONS, insertableItems, type InsertExtension, type InsertVariant } from "./insertionRegistry";
import { isMacPlatform, withShortcut } from "./shortcuts";

const IS_MAC = isMacPlatform();

/**
 * Toolbar controls built from the insertion registry. The Insert dropdown holds the
 * insert-only items; the toggleable directives (panels, TOC) keep their own top-level
 * control. All of them dispatch the registry's commands, so they share the exact
 * insertion logic with the slash menu and keyboard shortcuts.
 *
 * Flyout entries are label-only (matching the block-type flyout) — a `createButtonGroup`
 * renders a text list, which sidesteps the icon-ligature concerns noted in spec 006.
 */

function findEntry(name: string): InsertExtension {
    const entry = INSERT_EXTENSIONS.find((candidate) => candidate.name === name);
    if (entry === undefined) {
        throw new Error(`Unknown insert extension: ${name}`);
    }
    return entry;
}

/** A block button for an insert variant: the shared onClick (dispatch the variant) and active-state wiring. */
function createVariantButton(
    variant: InsertVariant,
    presentation: Omit<Parameters<typeof createBlockButton>[0], "onClick" | "isActive">
): ButtonType {
    return createBlockButton({
        ...presentation,
        onClick: (event, editor) => {
            if (editor) {
                variant.insert(editor);
            }
        },
        isActive: (selection) => variant.isActive?.(selection) ?? false
    });
}

/** The toolbar "Insert" dropdown — registry items flagged for the insert menu (table, image, rule). */
export function createInsertMenuButton(localize: Localize): StaticToolbarProps.Item {
    const buttons = insertableItems()
        .filter((item) => item.surfaces.insertMenu)
        .map((item) => {
            const label = localize(item.labelKey);
            return createBlockButton({
                label,
                title: withShortcut(label, item.keyboardShortcut, IS_MAC),
                onClick: (event, editor) => {
                    if (editor) {
                        item.insert(editor);
                    }
                },
                isActive: (selection) => item.isActive(selection)
            });
        });
    return createButtonGroup({
        icon: <Icon iconTheme="outlined">add</Icon>,
        title: localize(RESOURCE_KEYS.markdownEditor.insert.menu),
        buttons
    });
}

/** Top-level "Panel" flyout — the admonition variants, each active (checkmark) when the caret is in that panel. */
export function createPanelToolbarGroup(localize: Localize): StaticToolbarProps.Item {
    const entry = findEntry("admonition");
    const buttons = entry.variants.map((variant) => {
        const label = localize(variant.labelKey);
        return createVariantButton(variant, { label, title: withShortcut(label, variant.keyboardShortcut, IS_MAC) });
    });
    return createButtonGroup({ icon: entry.icon, title: localize(entry.labelKey), buttons });
}

/** Top-level "Table of contents" toggle button (active when the caret is on the TOC). */
export function createTocToolbarButton(localize: Localize): StaticToolbarProps.Item {
    const entry = findEntry("toc");
    const variant = entry.variants[0]!;
    return createVariantButton(variant, {
        icon: variant.icon,
        title: withShortcut(localize(variant.labelKey), variant.keyboardShortcut, IS_MAC)
    });
}
