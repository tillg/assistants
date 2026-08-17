import type { View } from "@com.mgmtp.a12.client/client-core";

import { AssistantsTile } from "./AssistantsTile";
import { BookkeepingTile } from "./BookkeepingTile";
import { ConversationsTile } from "./ConversationsTile";
import { DocumentsTile } from "./DocumentsTile";

type ViewMap = Record<string, View.ViewComponent | undefined>;

/**
 * The Dashboard's four views, named exactly as `AssistantsAppModel_AM.json` names them in its `VIEW_ADD`
 * directives. Each entry must be registered via a corresponding `addView()` call in `appsetup.ts`.
 *
 * **The order of the directives is the layout.** `DashboardLayout` walks the region settings' columns and
 * consumes `views[i++]` at each leaf, so slot *i* takes view *i* — left to right at desktop width, top to
 * bottom when stacked. There is no naming mechanism on offer, which is why `10-dashboard.spec.ts` asserts
 * the Tiles' on-screen order against `DashboardPage.TILES`: a reordering is then caught rather than
 * merely noticed.
 *
 * None of these views takes a model. Each Tile fetches its own numbers and gets `{ name, activityId,
 * ariaLevel }` and nothing else — the props a model-less `VIEW_ADD` hands over.
 */
export const dashboardViewMap = {
    ConversationsTile,
    DocumentsTile,
    AssistantsTile,
    BookkeepingTile
} satisfies ViewMap;
