import { PLACE_ICONS } from "../icons";

import { DashboardTile } from "./DashboardTile";

/**
 * The one Tile with no number, and the reason is architectural rather than unfinished: Bookkeeping is
 * the Authority for balances, the browser holds no Firefly credential — oauth2-proxy runs its own OIDC
 * flow and forwards a header — and the only component holding a Firefly token is the Runtime, which
 * offers no API by design (ADR-0011). A balance here would need one of those three facts to change.
 *
 * So it is a door: no query, no headline, no footer, and permanently `ready`, because it has nothing to
 * load and nothing that can fail.
 */

/**
 * Firefly's own address, pinned in `compose/docker-compose.yml` as its `APP_URL` and as oauth2-proxy's
 * `OAUTH2_PROXY_REDIRECT_URL`. Not configurable, because it is not configurable there either — a third
 * place stating it would make two of the three wrong eventually.
 */
const BOOKKEEPING_URL = "http://localhost:8084";

export function BookkeepingTile() {
    return (
        <DashboardTile
            role="tile-bookkeeping"
            icon={PLACE_ICONS.bookkeeping}
            title="Bookkeeping"
            state="ready"
            href={BOOKKEEPING_URL}
            body={<p>The books are in Firefly III. Opens in a new tab, on the same login.</p>}
        />
    );
}
