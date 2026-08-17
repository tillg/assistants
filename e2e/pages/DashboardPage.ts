/*
 * SPDX-License-Identifier: EUPL-1.2
 *
 * Copyright (c) 2026 Till Gartner
 *
 * Part of Assistants.
 *
 * Licensed under the European Union Public Licence, version 1.2 - see
 * https://eupl.eu/ and the LICENSE file at the root of this repository.
 * Distributed on an "AS IS" basis, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.
 */

import type { Locator } from "@playwright/test";

import { expect, type Page } from "../fixtures";

import { BasePage } from "./BasePage";

/** The four Tiles, in the order the App Model's `VIEW_ADD` directives place them. */
export const TILES = ["conversations", "documents", "assistants", "bookkeeping"] as const;

export type TileName = (typeof TILES)[number];

/**
 * The Dashboard, in Playwright's terms.
 *
 * The Tiles fetch through `Dispatcher.rpc` directly, **outside** the activity machinery, so no progress
 * overlay ever appears for them and `finishedLoading()` returns while the numbers are still in flight.
 * {@link waitForTiles} is the cover for that, and it is the alternative to an arbitrary sleep: every Tile
 * carries `data-state`, and the spec waits until none of them says `loading`.
 */
export class DashboardPage extends BasePage {
    constructor(protected override readonly page: Page) {
        super(page);
    }

    tile(name: TileName): Locator {
        return this.page.locator(`[data-role="tile-${name}"]`);
    }

    /** Every Tile on the Dashboard — the four frames, not the slots inside them. */
    allTiles(): Locator {
        return this.page.locator("[data-role^='tile-'][data-state]");
    }

    /**
     * Waits until no Tile is loading any more. The bookkeeping Tile needs no exception: it issues no
     * query and is therefore born `ready`.
     */
    async waitForTiles(timeout = 30_000) {
        await expect(this.allTiles()).toHaveCount(TILES.length);
        await expect(this.page.locator("[data-role^='tile-'][data-state='loading']")).toHaveCount(0, { timeout });
    }

    /** A Tile's one big number, as text. The bookkeeping Tile has none, by design. */
    async headline(name: TileName): Promise<string> {
        return (await this.tile(name).locator(`[data-role="tile-${name}-headline"]`).innerText()).trim();
    }

    /** One line of a Tile's body, by its own role — e.g. `waiting-on-you` on the conversations Tile. */
    line(name: TileName, role: string): Locator {
        return this.tile(name).locator(`[data-role="tile-${name}-${role}"]`);
    }

    /**
     * The Tiles in the order they are on screen, by name. Slot pairing is positional — the order of the
     * `VIEW_ADD` directives *is* the layout — so this is what makes a silent reordering fail a test.
     */
    async tileOrder(): Promise<string[]> {
        const roles = await this.allTiles().evaluateAll((tiles) =>
            tiles.map((tile) => tile.getAttribute("data-role") ?? "")
        );
        return roles.map((role) => role.replace(/^tile-/, ""));
    }

    /** How many Tiles are showing their error line. Zero, on the happy path. */
    failedTiles(): Locator {
        return this.page.locator("[data-role^='tile-'][data-state='error']");
    }

    /** The leading integer of a headline: `318 in flight` is 318, and `49` is 49. */
    async headlineNumber(name: TileName): Promise<number> {
        const text = await this.headline(name);
        const [first] = /\d+/.exec(text) ?? [];
        expect(first, `the ${name} Tile's headline "${text}" carries no number`).toBeDefined();
        return Number(first);
    }

    /** The leading integer of one body line, the same way. */
    async lineNumber(name: TileName, role: string): Promise<number> {
        const text = (await this.line(name, role).innerText()).trim();
        const [first] = /\d+/.exec(text) ?? [];
        expect(first, `the ${name} Tile's "${role}" line reads "${text}" and carries no number`).toBeDefined();
        return Number(first);
    }

    async openTile(name: TileName) {
        await this.tile(name).click();
        await this.finishedLoading();
    }
}
