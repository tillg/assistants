import { useMemo } from "react";

import type { LinkPluginConfig } from "@com.mgmtp.a12.widgets/widgets-core";

import { FollowLinkContent } from "./FollowLinkContent";

/** How links behave in the editor: open in a new tab, and offer a follow-link popup on click. */
export function useLinkPluginConfig(): LinkPluginConfig {
    return useMemo(
        () => ({
            target: "_blank",
            popupRenderer: (info) => <FollowLinkContent href={info.href} />
        }),
        []
    );
}
