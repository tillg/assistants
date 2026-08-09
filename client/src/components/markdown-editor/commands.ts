import { INSERT_HORIZONTAL_RULE_COMMAND } from "@lexical/extension";
import { INSERT_TABLE_COMMAND } from "@lexical/table";
import { createCommand, type LexicalCommand } from "lexical";

import type { AdmonitionVariant } from "./nodes/AdmonitionNode";

/**
 * Every editor-level Lexical command lives here so the three insertion surfaces
 * (toolbar, slash menu, keyboard shortcuts) and the plugins that handle the
 * commands share one import site — the dispatcher never depends on the toolbar.
 *
 * Two are re-exported from Lexical rather than created here: table insertion is
 * handled by the stock `TablePlugin`, and horizontal-rule insertion reuses the
 * canonical command (our `InsertionCommandsPlugin` registers the handler, since
 * we don't mount Lexical's `HorizontalRulePlugin`).
 */
export { INSERT_TABLE_COMMAND, INSERT_HORIZONTAL_RULE_COMMAND };

/** Dispatched by the link toolbar button; handled by {@link LinkDialogPlugin}. */
export const OPEN_LINK_DIALOG_COMMAND: LexicalCommand<void> = createCommand("OPEN_LINK_DIALOG_COMMAND");

/** Dispatched by the image insert item; handled by {@link ImageDialogPlugin}. */
export const OPEN_IMAGE_DIALOG_COMMAND: LexicalCommand<void> = createCommand("OPEN_IMAGE_DIALOG_COMMAND");

/** Dispatched by the text-color toolbar button; handled by {@link ColorDialogPlugin}. */
export const OPEN_COLOR_DIALOG_COMMAND: LexicalCommand<void> = createCommand("OPEN_COLOR_DIALOG_COMMAND");

/** Insert (or retype/toggle) an admonition panel of the given variant; handled by {@link InsertionCommandsPlugin}. */
export const INSERT_ADMONITION_COMMAND: LexicalCommand<AdmonitionVariant> = createCommand("INSERT_ADMONITION_COMMAND");

/** Insert (or toggle off) the table-of-contents block; handled by {@link InsertionCommandsPlugin}. */
export const INSERT_TABLE_OF_CONTENTS_COMMAND: LexicalCommand<void> = createCommand("INSERT_TABLE_OF_CONTENTS_COMMAND");
