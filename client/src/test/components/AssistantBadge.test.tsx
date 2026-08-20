import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import { ConnectorLocator, type RestRequestPayload, type ServerConnector } from "@com.mgmtp.a12.utils/utils-connector";
import { LoggerFactory } from "@com.mgmtp.a12.utils/utils-logging";

import { AssistantBadge } from "../../components/AssistantBadge";
import { ICONS } from "../../components/icons";

import { Frame } from "./conversation/harness";

/**
 * The one way the system names an Assistant: 🤖 + the resolved Name, degrading to the key when no
 * Assistant carries it. The glyph is the type, so it is hidden from a reader who is read to.
 */

function install(entries: object[], ok = true): void {
    ConnectorLocator.createInstance({
        fetchData: (payload: RestRequestPayload) => {
            const requests = JSON.parse(String(payload.body)) as { id: unknown }[];
            return Promise.resolve({
                ok,
                statusText: "Boom",
                json: () =>
                    Promise.resolve(
                        requests.map((request) => ({
                            jsonrpc: "2.0",
                            id: request.id,
                            result: {
                                page: { pageNumber: 0, pageSize: 1 },
                                fullSize: entries.length,
                                entries,
                                links: [],
                                otherResults: {}
                            }
                        }))
                    )
            } as unknown as Response);
        }
    } as unknown as ServerConnector);
}

function entry(key: string, name: string): object {
    return { type: "ROOT", docRef: `Assistant_DM/${key}`, document: { Assistant: { Key: key, Name: name } } };
}

describe("AssistantBadge", () => {
    beforeEach(() => {
        vi.spyOn(LoggerFactory.getLogger("PT/useAssistantName"), "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("shows 🤖 and the resolved Name", async () => {
        install([entry("badge-receptionist", "Receptionist")]);

        render(
            <Frame>
                <span data-role="badge">
                    <AssistantBadge assistantKey="badge-receptionist" />
                </span>
            </Frame>
        );

        await waitFor(() => expect(screen.getByTestId("badge")).toHaveTextContent("Receptionist"));
        expect(screen.getByTestId("badge")).toHaveTextContent(ICONS.assistant);
    });

    it("shows the key when no Assistant resolves it", async () => {
        install([]);

        render(
            <Frame>
                <span data-role="badge">
                    <AssistantBadge assistantKey="badge-ghost" />
                </span>
            </Frame>
        );

        // It never blanks: the key stands from the first frame and stays once the empty read returns.
        expect(screen.getByTestId("badge")).toHaveTextContent("badge-ghost");
        await waitFor(() => expect(screen.getByTestId("badge")).toHaveTextContent("badge-ghost"));
    });

    it("hides the 🤖 from a reader who is read to", async () => {
        install([entry("badge-hidden", "Accountant")]);

        render(
            <Frame>
                <span data-role="badge">
                    <AssistantBadge assistantKey="badge-hidden" />
                </span>
            </Frame>
        );

        await waitFor(() => expect(screen.getByTestId("badge")).toHaveTextContent("Accountant"));
        expect(screen.getByTestId("badge").querySelector("[aria-hidden='true']")).toHaveTextContent(ICONS.assistant);
    });
});
