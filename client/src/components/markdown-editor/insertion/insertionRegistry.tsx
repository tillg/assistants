import type { BaseSelection, LexicalCommand, LexicalEditor } from "lexical";
import type { ReactNode } from "react";

import { Icon } from "@com.mgmtp.a12.widgets/widgets-core";

import { RESOURCE_KEYS } from "../../../localization";

import {
    INSERT_ADMONITION_COMMAND,
    INSERT_HORIZONTAL_RULE_COMMAND,
    INSERT_TABLE_COMMAND,
    INSERT_TABLE_OF_CONTENTS_COMMAND,
    OPEN_IMAGE_DIALOG_COMMAND,
    OPEN_LINK_DIALOG_COMMAND
} from "../commands";
import { $isAdmonitionNode, ADMONITION_VARIANTS, admonitionChrome } from "../nodes/AdmonitionNode";

import { $tocNodeAtSelection, $topLevelElement } from "./blockInsertion";

/**
 * Central registry of insertable editor features (ported from w12-free's extension
 * registry). Every surface — the toolbar Insert menu, the top-level Panel/TOC/Link
 * controls, the slash command menu, and the keyboard-shortcut binder — derives from
 * this one list, so they can never drift and a parity-audit test has a single source.
 *
 * `surfaces` decides where each entry appears. The toggleable directives (panels, TOC)
 * and link are `insertMenu: false`: they keep their own top-level toolbar control but
 * still show up in the slash menu. A single entry may expose several `variants` (the
 * five admonition panels); each variant is a distinct item dispatching the entry's
 * command with its own baked payload.
 */

/** Which insertion surfaces an entry/variant appears on. Omitted flags default to true. */
export interface InsertSurfaces {
    /** The toolbar "Insert" dropdown. */
    insertMenu: boolean;
    /** The `/` slash command menu. */
    slashMenu: boolean;
    /** The keyboard-shortcut binder (only meaningful with a `keyboardShortcut`). */
    shortcut: boolean;
}

export interface InsertVariant {
    /** "" for a single-variant entry, otherwise the variant id (e.g. `"info"`). */
    id: string;
    /** English label — the keyword-derivation source and the fallback when no localizer is supplied. */
    displayName: string;
    /** Resource key resolved to the surface-rendered (localized) label. */
    labelKey: string;
    /** Icon for the slash menu / top-level flyout trigger. */
    icon: ReactNode;
    /** Dispatch the entry command with this variant's baked payload. */
    insert(editor: LexicalEditor): void;
    /**
     * Whether the selection already sits on this item's node — surfaces render it
     * active (a checkmark), and for the toggleable directives (panels, TOC) the
     * command then toggles it off. Omitted for insert-only items (table, image, rule).
     */
    isActive?(selection: BaseSelection | null): boolean;
    slashKeywords?: readonly string[];
    /** Mousetrap-style binding, e.g. `"mod+alt+i"`. */
    keyboardShortcut?: string;
    surfaces?: Partial<InsertSurfaces>;
}

export interface InsertExtension {
    name: string;
    /** English label — fallback and keyword-derivation source (see {@link InsertVariant.displayName}). */
    displayName: string;
    /** Resource key resolved to the localized label for this entry's top-level control (group title). */
    labelKey: string;
    /** Icon for the top-level toolbar control and slash menu. */
    icon: ReactNode;
    /** The command every variant of this entry dispatches (the parity-audit anchor). */
    command: LexicalCommand<unknown>;
    displayOrder: number;
    /** Keywords shared by every variant (merged into each item's search terms). */
    slashKeywords?: readonly string[];
    /** Surfaces every variant inherits (a variant may still override individual flags). */
    surfaces?: Partial<InsertSurfaces>;
    variants: readonly InsertVariant[];
}

const outlined = (name: string): ReactNode => <Icon iconTheme="outlined">{name}</Icon>;

/**
 * Admonition variant keyboard shortcuts. Info/warning/note get `mod+alt+{i,w,n}`;
 * tip and panel are left unbound (no mnemonic assigned).
 *
 * Note: on Linux/Windows `mod` is Ctrl, and `Ctrl+Alt+<letter>` is a crowded namespace
 * (the window manager reserves `Ctrl+Alt+T`, `Ctrl+Alt+F<n>`, `Ctrl+Alt+<arrow>` …), so
 * these can still collide on some setups — JS cannot override an OS-grabbed combo.
 */
const ADMONITION_SHORTCUTS: Partial<Record<string, string>> = {
    info: "mod+alt+i",
    warning: "mod+alt+w",
    note: "mod+alt+n"
};

/** Localization key per admonition variant (the neutral `panel` fallback covers unknown types). */
const PANEL_LABEL_KEYS: Record<string, string> = {
    info: RESOURCE_KEYS.markdownEditor.panel.info,
    warning: RESOURCE_KEYS.markdownEditor.panel.warning,
    note: RESOURCE_KEYS.markdownEditor.panel.note,
    tip: RESOURCE_KEYS.markdownEditor.panel.tip,
    panel: RESOURCE_KEYS.markdownEditor.panel.panel
};

/** The 2×2 starter grid (header row + one body row) — w12-free's insert default. */
const TABLE_INSERT_PAYLOAD = { columns: "2", rows: "2", includeHeaders: { rows: true, columns: false } } as const;

/** Toggleable directives and link keep a dedicated toolbar control, so they stay out of the Insert dropdown. */
const SLASH_ONLY: Partial<InsertSurfaces> = { insertMenu: false };

export const INSERT_EXTENSIONS: readonly InsertExtension[] = [
    {
        name: "table",
        displayName: "Table",
        labelKey: RESOURCE_KEYS.markdownEditor.insert.table,
        icon: outlined("grid_on"),
        command: INSERT_TABLE_COMMAND,
        displayOrder: 10,
        slashKeywords: ["table", "grid"],
        variants: [
            {
                id: "",
                displayName: "Table",
                labelKey: RESOURCE_KEYS.markdownEditor.insert.table,
                icon: outlined("grid_on"),
                // Not `t`: `Ctrl+Alt+T` is the Linux "open terminal" WM shortcut (unblockable from JS).
                keyboardShortcut: "mod+alt+a",
                insert: (editor) => editor.dispatchCommand(INSERT_TABLE_COMMAND, TABLE_INSERT_PAYLOAD)
            }
        ]
    },
    {
        name: "image",
        displayName: "Image",
        labelKey: RESOURCE_KEYS.markdownEditor.insert.image,
        icon: outlined("image"),
        command: OPEN_IMAGE_DIALOG_COMMAND,
        displayOrder: 20,
        slashKeywords: ["image", "picture", "photo"],
        variants: [
            {
                id: "",
                displayName: "Image",
                labelKey: RESOURCE_KEYS.markdownEditor.insert.image,
                icon: outlined("image"),
                // Opens the image dialog rather than inserting directly (source/alt-text choice).
                insert: (editor) => editor.dispatchCommand(OPEN_IMAGE_DIALOG_COMMAND, undefined)
            }
        ]
    },
    {
        name: "hr",
        displayName: "Horizontal rule",
        labelKey: RESOURCE_KEYS.markdownEditor.insert.horizontalRule,
        icon: outlined("horizontal_rule"),
        command: INSERT_HORIZONTAL_RULE_COMMAND,
        displayOrder: 30,
        slashKeywords: ["horizontal", "rule", "divider", "line", "separator"],
        variants: [
            {
                id: "",
                displayName: "Horizontal rule",
                labelKey: RESOURCE_KEYS.markdownEditor.insert.horizontalRule,
                icon: outlined("horizontal_rule"),
                insert: (editor) => editor.dispatchCommand(INSERT_HORIZONTAL_RULE_COMMAND, undefined)
            }
        ]
    },
    {
        name: "admonition",
        displayName: "Panel",
        labelKey: RESOURCE_KEYS.markdownEditor.panel.group,
        icon: outlined("info"),
        command: INSERT_ADMONITION_COMMAND,
        displayOrder: 40,
        slashKeywords: ["panel", "admonition", "callout", "note", "box"],
        surfaces: SLASH_ONLY,
        variants: ADMONITION_VARIANTS.map((variant) => {
            const { icon, label } = admonitionChrome(variant);
            return {
                id: variant,
                displayName: label,
                labelKey: PANEL_LABEL_KEYS[variant] ?? RESOURCE_KEYS.markdownEditor.panel.panel,
                icon: outlined(icon),
                slashKeywords: [variant],
                keyboardShortcut: ADMONITION_SHORTCUTS[variant],
                insert: (editor) => editor.dispatchCommand(INSERT_ADMONITION_COMMAND, variant),
                isActive: (selection) => {
                    const element = $topLevelElement(selection);
                    return $isAdmonitionNode(element) && element.getAdmonitionType() === variant;
                }
            };
        })
    },
    {
        name: "toc",
        displayName: "Table of contents",
        labelKey: RESOURCE_KEYS.markdownEditor.insert.tableOfContents,
        icon: outlined("toc"),
        command: INSERT_TABLE_OF_CONTENTS_COMMAND,
        displayOrder: 50,
        slashKeywords: ["toc", "contents", "outline", "index", "table of contents"],
        surfaces: SLASH_ONLY,
        variants: [
            {
                id: "",
                displayName: "Table of contents",
                labelKey: RESOURCE_KEYS.markdownEditor.insert.tableOfContents,
                icon: outlined("toc"),
                keyboardShortcut: "mod+alt+o",
                insert: (editor) => editor.dispatchCommand(INSERT_TABLE_OF_CONTENTS_COMMAND, undefined),
                isActive: (selection) => $tocNodeAtSelection(selection) !== null
            }
        ]
    },
    {
        name: "link",
        displayName: "Link",
        labelKey: RESOURCE_KEYS.markdownEditor.insert.link,
        icon: outlined("link"),
        command: OPEN_LINK_DIALOG_COMMAND,
        displayOrder: 60,
        slashKeywords: ["link", "url", "hyperlink", "anchor"],
        surfaces: SLASH_ONLY,
        variants: [
            {
                id: "",
                displayName: "Link",
                labelKey: RESOURCE_KEYS.markdownEditor.insert.link,
                icon: outlined("link"),
                // Ctrl/Cmd+K — the universal editor "insert link" combo (browser-level, so preventDefault works).
                keyboardShortcut: "mod+k",
                insert: (editor) => editor.dispatchCommand(OPEN_LINK_DIALOG_COMMAND, undefined)
            }
        ]
    }
];

/** A single flattened insertion item — one per variant — that any surface can render. */
export interface InsertMenuItem {
    /** Unique key: the entry name, or `${name}:${variant.id}` for multi-variant entries. */
    key: string;
    /** English label — keyword-derivation source and no-localizer fallback. */
    displayName: string;
    /** Resource key resolved to the surface-rendered (localized) label. */
    labelKey: string;
    icon: ReactNode;
    command: LexicalCommand<unknown>;
    insert(editor: LexicalEditor): void;
    /** True when the selection sits on this item's node (toggleable directives only). */
    isActive(selection: BaseSelection | null): boolean;
    /** displayName tokens + entry + variant keywords, lower-cased, for slash-menu filtering. */
    slashKeywords: readonly string[];
    keyboardShortcut?: string;
    surfaces: InsertSurfaces;
    displayOrder: number;
}

const DEFAULT_SURFACES: InsertSurfaces = { insertMenu: true, slashMenu: true, shortcut: true };

/** Flatten the registry to one item per variant (with resolved surfaces), ordered by `displayOrder`. */
export function insertableItems(): InsertMenuItem[] {
    return INSERT_EXTENSIONS.flatMap((entry) =>
        entry.variants.map((variant) => ({
            key: variant.id === "" ? entry.name : `${entry.name}:${variant.id}`,
            displayName: variant.displayName,
            labelKey: variant.labelKey,
            icon: variant.icon,
            command: entry.command,
            insert: variant.insert,
            isActive: variant.isActive ?? (() => false),
            slashKeywords: [
                ...variant.displayName.toLowerCase().split(/\s+/),
                ...(entry.slashKeywords ?? []),
                ...(variant.slashKeywords ?? [])
            ],
            keyboardShortcut: variant.keyboardShortcut,
            surfaces: { ...DEFAULT_SURFACES, ...entry.surfaces, ...variant.surfaces },
            displayOrder: entry.displayOrder
        }))
    ).sort((a, b) => a.displayOrder - b.displayOrder);
}
