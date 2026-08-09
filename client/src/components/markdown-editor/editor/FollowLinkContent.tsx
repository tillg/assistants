import styled, { css } from "styled-components";

import { ExternalLink } from "@com.mgmtp.a12.widgets/widgets-core";

import { isBlockedUrl } from "../urlSafety";

interface FollowLinkContentProps {
    href: string;
}

const truncate = css`
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
`;

const popupLayout = css`
    ${truncate};
    display: flex;
    align-items: center;
    gap: 4px;
    max-width: 320px;
`;

/** A12's external-link widget — it adds the new-tab target and the open-in-new
 *  icon itself; we only lay it out for the popup and truncate the URL. */
const FollowExternalLink = styled(ExternalLink)`
    ${popupLayout}
`;

const BlockedUrl = styled.span`
    ${popupLayout}
`;

const UrlText = styled.span`
    ${truncate}
`;

/**
 * Content rendered inside the follow-link popup when the cursor hovers over a link.
 * Shows the truncated URL as an A12 ExternalLink (opens in a new tab with an
 * open-in-new icon). Always opens in a new tab (AC 10): markdown has no target
 * notion, and the spec requires new-tab behavior unconditionally.
 */
export function FollowLinkContent({ href }: FollowLinkContentProps) {
    // Never make a javascript:/data: target clickable (spec 008): show it as
    // plain, non-navigating text instead of a link.
    if (isBlockedUrl(href)) {
        return (
            <BlockedUrl>
                <UrlText>{href}</UrlText>
            </BlockedUrl>
        );
    }

    return (
        <FollowExternalLink href={href} linkAttributes={{ rel: "noopener noreferrer" }}>
            <UrlText>{href}</UrlText>
        </FollowExternalLink>
    );
}
