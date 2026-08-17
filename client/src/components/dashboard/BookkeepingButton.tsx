import { PLACE_ICONS } from "../icons";

import { DashboardTile } from "./DashboardTile";

/**
 * The door to the books, drawn as a control rather than as a summary.
 *
 * It was a Tile, and it was the only one with no number — not because the number was unfinished but
 * because the browser could not ask for one. Beside three Tiles that each carry a big figure, in the
 * same frame at the same minimum height, that read as *a Tile whose number failed to load*: the one
 * sentence a working door must not say. It has nothing to summarise, so it is shaped like the thing it
 * actually is.
 *
 * The Accounts and Transactions Tiles now show what the books hold, and this stays anyway: a summary is
 * not a way in. A User who wants to *book* something needs the door, and burying it in a Tile's corner
 * makes it a guess.
 *
 * `data-role` is unchanged — the e2e page object and its assertions still find it as `tile-bookkeeping`,
 * and `data-variant` is what tells the two shapes apart.
 */

/**
 * Firefly's own address, pinned in `compose/docker-compose.yml` as its `APP_URL` and as oauth2-proxy's
 * `OAUTH2_PROXY_REDIRECT_URL`. Not configurable, because it is not configurable there either — a third
 * place stating it would make two of the three wrong eventually.
 */
export const BOOKKEEPING_URL = "http://localhost:8084";

export function BookkeepingButton() {
    return (
        <DashboardTile
            role="tile-bookkeeping"
            icon={PLACE_ICONS.bookkeeping}
            title="Bookkeeping"
            state="ready"
            variant="button"
            href={BOOKKEEPING_URL}
        />
    );
}
