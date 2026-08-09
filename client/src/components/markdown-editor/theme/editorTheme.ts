import { type EditorThemeClasses } from "lexical";
import { createGlobalStyle } from "styled-components";

/**
 * Lexical theme classes for nodes the A12 RTE default theme does not cover.
 * Deep-merged into the widget's editorThemeClasses via initialConfig.theme
 * (RichTextEditorComposer deep-merges defaultConfig() with the user initialConfig).
 */
export const MARKDOWN_EDITOR_THEME = {
    admonition: "md-editor-admonition",
    hr: "md-editor-hr",
    hrSelected: "md-editor-hr-selected",
    image: "md-editor-image",
    list: {
        listitemChecked: "md-editor-listitem-checked",
        listitemUnchecked: "md-editor-listitem-unchecked"
    },
    table: "md-editor-table",
    tableCell: "md-editor-table-cell",
    tableCellHeader: "md-editor-table-cell-header",
    tableCellSelected: "md-editor-table-cell-selected",
    tableSelected: "md-editor-table-selected"
} satisfies EditorThemeClasses;

/**
 * Styling for the theme classes above (the A12 RTE theme has no table styles).
 * Colors come from the A12 widget theme via styled-components' ThemeProvider
 * (see app/page/index.tsx); `theme.colors.*` is typed by widgets-core's augmented
 * styled-components DefaultTheme.
 */
export const MarkdownEditorGlobalStyles = createGlobalStyle`
    .md-editor-image img {
        max-width: 100%;
    }
    .md-editor-table {
        border-collapse: collapse;
        margin: 8px 0;
    }
    .md-editor-table-cell {
        border: 1px solid ${({ theme }) => theme.colors.divider.color};
        padding: 4px 8px;
        min-width: 48px;
        vertical-align: top;
    }
    .md-editor-table-cell-header {
        background: ${({ theme }) => theme.colors.background.nonInteractiveBackground};
        font-weight: 600;
        text-align: left;
    }
    .md-editor-table-cell-selected {
        background: ${({ theme }) => theme.colors.interaction.selected.colorLight};
    }
    .md-editor-table-selected {
        outline: 2px solid ${({ theme }) => theme.colors.interaction.selected.color};
    }
    /*
     * The rule is a non-editable decorator: a bare 1px line is nearly impossible to
     * click, so clicks miss it and resolve to no caret (a trap). Give it a taller
     * clickable box with the line drawn centred via ::after and a pointer cursor — the
     * stock HorizontalRuleNode click handler then node-selects it cleanly in one step
     * (no reactive correction, no flicker). The selected outline makes that visible.
     */
    .md-editor-hr {
        padding: 4px 0;
        border: none;
        margin: 8px 0;
        cursor: pointer;
    }
    .md-editor-hr::after {
        content: "";
        display: block;
        height: 1px;
        background: ${({ theme }) => theme.colors.divider.color};
    }
    .md-editor-hr.md-editor-hr-selected {
        outline: 2px solid ${({ theme }) => theme.colors.interaction.selected.color};
    }

    /*
     * Check-list (task list) styling. The widget's default theme defines no
     * checked/unchecked list-item classes and its rich-text-editor.css carries
     * no checkbox rules, so the checkbox marker is drawn here (adapted from the
     * Lexical playground). The left padding is also the click target that
     * CheckListPlugin toggles; in read-only mode the plugin no-ops, so the
     * checkbox renders but is inert.
     */
    .md-editor-listitem-checked,
    .md-editor-listitem-unchecked {
        position: relative;
        /* Bullet/numbered lists indent their text via the <ul>/<ol> padding; check
         * items get their gutter from the <li> padding instead (the checkbox lives
         * there, and CheckListPlugin's click-toggle needs it there). The negative
         * margin = -padding cancels that extra indent so the text lines up with
         * bullet/numbered text while the checkbox hangs into the list gutter. */
        margin-left: -24px;
        padding-left: 24px;
        list-style-type: none;
        outline: none;
    }
    .md-editor-listitem-checked {
        text-decoration: line-through;
    }
    .md-editor-listitem-checked:before,
    .md-editor-listitem-unchecked:before {
        content: "";
        position: absolute;
        /* Center the 16px box on the text line. lh keeps it aligned if the editor
         * font size changes; the fixed value is the fallback for older engines. */
        top: 1px;
        top: calc((1lh - 16px) / 2);
        left: 0;
        width: 16px;
        height: 16px;
        border: 1px solid ${({ theme }) => theme.colors.divider.color};
        border-radius: 2px;
        cursor: pointer;
    }
    .md-editor-listitem-checked:before {
        background: ${({ theme }) => theme.colors.interaction.selected.color};
        border-color: ${({ theme }) => theme.colors.interaction.selected.color};
    }
    .md-editor-listitem-checked:after {
        content: "";
        position: absolute;
        /* 3px below the box top — kept in sync with the box's top offset above. */
        top: 4px;
        top: calc((1lh - 16px) / 2 + 3px);
        left: 6px;
        width: 3px;
        height: 7px;
        border: solid #ffffff;
        border-width: 0 2px 2px 0;
        transform: rotate(45deg);
        cursor: pointer;
    }

    /*
     * The widget's default Lexical theme assigns these .editor-* class names but its
     * rich-text-editor.css is never imported by the widget (or anything else), so
     * class-only effects silently do nothing. Importing that CSS wholesale would drag
     * in unwanted rules (tiny .editor-paragraph font, link colors), so the two rules
     * the markdown editor needs are replicated here:
     * - strikethrough has no native tag in Lexical, it is theme-class-only;
     * - a nested list's wrapper <li> needs its own marker hidden, or every
     *   indent level draws an extra bullet.
     */
    .editor-text-strikethrough {
        text-decoration: line-through;
    }
    .editor-nested-listitem {
        list-style-type: none;
    }
    /*
     * A nested-list container <li> only holds the sub-list, but as a direct child
     * of a check <ul> it inherits md-editor-listitem-unchecked and would draw a
     * stray (empty) checkbox above the nested item — suppress the marker
     * pseudo-elements on it. (Bullet/numbered containers have no ::before, so this
     * is a no-op for them.)
     */
    .editor-nested-listitem:before,
    .editor-nested-listitem:after {
        content: none;
    }

    /*
     * Admonition panels. AdmonitionNode is an ElementNode whose children are the
     * editable body; the type-colored container is keyed on data-admonition-type,
     * and the title row is a non-editable header element built in the node's
     * createDOM (icon glyph + variant label). This CSS is the lexical-internal
     * chrome for that node — the icon glyph uses the Material Symbols Outlined font.
     * Unknown/unstyled types fall back to the neutral base rule.
     */
    .md-editor-admonition {
        margin: 12px 0;
        padding: 8px 12px;
        border: 1px solid ${({ theme }) => theme.colors.divider.color};
        border-left: 4px solid ${({ theme }) => theme.colors.divider.colorDark};
        border-radius: 4px;
        background: ${({ theme }) => theme.colors.background.groupBackground};
    }
    .md-editor-admonition-header {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 4px;
        font-weight: 600;
        color: ${({ theme }) => theme.colors.text.color};
        user-select: none;
    }
    .md-editor-admonition-icon {
        font-family: "Material Symbols Outlined";
        font-size: 18px;
        font-weight: normal;
        font-style: normal;
        line-height: 1;
        font-feature-settings: "liga";
        -webkit-font-smoothing: antialiased;
    }
    .md-editor-admonition-header + * {
        margin-top: 0;
    }
    .md-editor-admonition > :last-child {
        margin-bottom: 0;
    }
    .md-editor-admonition[data-admonition-type="info"] {
        border-left-color: ${({ theme }) => theme.colors.variant.infoColor};
        background: ${({ theme }) => theme.colors.variant.infoColorLighter};
    }
    .md-editor-admonition[data-admonition-type="warning"] {
        border-left-color: ${({ theme }) => theme.colors.variant.warningColor};
        background: ${({ theme }) => theme.colors.variant.warningColorLight};
    }
    .md-editor-admonition[data-admonition-type="tip"] {
        border-left-color: ${({ theme }) => theme.colors.variant.successColor};
        background: ${({ theme }) => theme.colors.variant.successColorLight};
    }
    .md-editor-admonition[data-admonition-type="missing"] {
        border-left-color: ${({ theme }) => theme.colors.variant.errorColor};
        background: ${({ theme }) => theme.colors.variant.errorColorLight};
    }
`;
