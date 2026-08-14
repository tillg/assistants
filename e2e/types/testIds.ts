/*
 * SPDX-License-Identifier: EUPL-1.2 OR LicenseRef-commercial
 *
 * Copyright (c) 2012-2026 mgm technology partners GmbH
 *
 * Dual License
 * ------------
 * This source file is part of the mgm A12 Platform and available under
 * a choice of two different licenses:
 *
 * 1. Open-Source License - EUPL v1.2
 *    You may redistribute and/or modify this file under the terms of the
 *    European Union Public License, version 1.2 - see https://eupl.eu/.
 *
 * 2. Commercial License
 *    Alternatively, you may obtain a commercial license from
 *    mgm technology partners GmbH, that permits use of this software
 *    under different terms (including support and maintenance services).
 *
 *    Please contact a12-license@mgm-tp.com for more information.
 *
 * You must select and comply with exactly one of the above license options.
 *
 * Warranty Disclaimer (applies to either option)
 * ----------------------------------------------
 * THIS SOFTWARE IS PROVIDED "AS IS" AND WITHOUT WARRANTY OF ANY KIND,
 * WHETHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
 * OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NON-INFRINGEMENT, EXCEPT WHERE SUCH DISCLAIMERS ARE HELD TO BE
 * LEGALLY INVALID. SEE THE RESPECTIVE LICENSE TEXT FOR DETAILS.
 */

export enum TestID {
    APPLICATION_HEADER = "application-header",
    BUTTON = "button",
    CONTENTBOX = "contentbox",
    CONTENTBOX_GROUP_ACTION_BAR = "contentbox-group-action-bar",
    CONTENTBOX_SUBHEADING = "contentbox-subheading",
    CONTENTBOX_TITLE = "contentbox-title",
    FILE_UPLOAD_CONTENT_INNER = "file-upload-content-inner",
    FILE_UPLOAD_CONTROL = "file-upload-control",
    FILE_UPLOAD_INPUT = "file-upload-input",
    FORM = "form",
    HEADER_TRIGGER_TEXT = "header-trigger-text",
    LIST_ITEM = "list-item",
    LIST_ITEM_TEXT = "list-item-text",
    MENU_ITEM = "menu-item",
    MESSAGE = "message",
    MODAL_OVERLAY_CONTENT = "modal-overlay-content",
    NOTIFICATION_ITEM_MESSAGE_CONTENT = "notification-item-message-content",
    NOTIFICATION_ITEM_TITLE = "notification-item-title",
    PLASMA_ICON = "plasma-icon",
    POPUP_MENU = "popup-menu",
    POPUP_TRIGGER_ELEMENT = "popup-trigger-element",
    PROGRESS_INDICATOR_INNER_OVERLAY = "progress-indicator-inner-overlay",
    PROGRESS_INDICATOR_OUTER_OVERLAY = "progress-indicator-outer-overlay",
    SELECT_INPUT = "select-input",
    TABLE = "table",
    TABLE_BODY = "table-body",
    TABLE_BODY_CELL = "table-body-cell",
    TABLE_BODY_ROW = "table-body-row",
    TEXTFIELD_CONTROL = "textfield-control",
    TEXTFIELD_INPUT = "textfield-input",
    TREE_NODE = "tree-node",
    TREE_NODE_CONTENT = "tree-node-content",
    TREE_NODE_EXPANDER = "tree-node-expander",
    TREE_NODE_NAME = "tree-node-name",
    TREE_NODE_TITLE = "tree-node-title",
    TYPOGRAPHY_SECTION = "typography-section"
}

/**
 * Test ids this application emits itself, from `client/src/components/conversation/`.
 *
 * `TestID` above is A12's — the platform stamps those, and a rename there is a platform upgrade.
 * These are ours, so they are kept apart as a **list**: it is the contract between the transcript
 * components and the specs, and nothing in the framework will keep it true for us.
 *
 * They are **not** kept apart as an attribute. Our components stamp `data-role`, exactly as the
 * platform does, because `playwright.config.ts` sets `testIdAttribute: "data-role"` — so that is
 * what `getByTestId` asks for, and one attribute means one way to find an element. Emitting the
 * React-conventional `data-testid` here instead is silent rather than noisy: the locator simply
 * never matches, which is how five transcript specs failed with "element(s) not found" against
 * elements that were on the page the whole time.
 */
export enum AppTestID {
    CONVERSATION_TRANSCRIPT = "conversation-transcript",
    PENDING_QUESTION = "pending-question",
    PENDING_QUESTION_ANSWER = "pending-question-answer",
    PENDING_QUESTION_OPTIONS = "pending-question-options",
    TRANSCRIPT_ABOUT = "transcript-about",
    TRANSCRIPT_ABOUT_LINK = "transcript-about-link",
    TRANSCRIPT_BLOCKED = "transcript-blocked",
    TRANSCRIPT_BUBBLE = "transcript-bubble",
    TRANSCRIPT_COST = "transcript-cost",
    TRANSCRIPT_COST_FOOTNOTE = "transcript-cost-footnote",
    TRANSCRIPT_HEADER = "transcript-header",
    TRANSCRIPT_MESSAGE = "transcript-message",
    TRANSCRIPT_PARENT_LINK = "transcript-parent-link",
    TRANSCRIPT_RECEIPT = "transcript-receipt",
    TRANSCRIPT_RECEIPT_BODY = "transcript-receipt-body",
    TRANSCRIPT_RECEIPT_TOGGLE = "transcript-receipt-toggle",
    TRANSCRIPT_SEPARATOR = "transcript-separator",
    TRANSCRIPT_STATE = "transcript-state",
    TRANSCRIPT_WHO = "transcript-who"
}

export enum CustomDataTestID {
    NOTIFICATION_HEADER = "[data-testid=notification-header]"
}

export enum Attribute {
    DATA_TREE_LEVEL = "data-tree-level"
}
