import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

import { ConnectorLocator, type RestRequestPayload, type ServerConnector } from "@com.mgmtp.a12.utils/utils-connector";
import { LoggerFactory } from "@com.mgmtp.a12.utils/utils-logging";

import { useAssistants } from "../../../components/dashboard/useAssistants";

/**
 * The one hook on the Dashboard that reads documents, so the one whose test has to say what it *keeps*:
 * three fields per Assistant, and not the body they came off.
 */

interface RpcRequest {
    readonly id: unknown;
    readonly method: string;
    readonly params: { readonly query: Record<string, unknown> };
}

let sent: RpcRequest[] = [];

/** One Assistant as the store hands it back: a document under its root, with everything on it. */
function entry(key: string, name: string, enabled: boolean): object {
    return {
        type: "ROOT",
        docRef: `Assistant_DM/${key}`,
        documentModelName: "Assistant_DM",
        document: {
            Assistant: {
                Key: key,
                Name: name,
                Enabled: enabled,
                SystemPrompt: "a very long prompt nobody on a Tile needs",
                Skills: [{ SkillName: "booking", SkillInstructions: "pages of markdown" }]
            }
        }
    };
}

function install(entries: object[], fullSize = entries.length, ok = true): void {
    sent = [];
    ConnectorLocator.createInstance({
        fetchData: (payload: RestRequestPayload) => {
            const requests = JSON.parse(String(payload.body)) as RpcRequest[];
            sent.push(...requests);
            return Promise.resolve({
                ok,
                statusText: "Boom",
                json: () =>
                    Promise.resolve(
                        requests.map((request) => ({
                            jsonrpc: "2.0",
                            id: request.id,
                            result: {
                                page: { pageNumber: 0, pageSize: 25 },
                                fullSize,
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

const TWO = [entry("receptionist", "Receptionist", true), entry("accountant", "Accountant", false)];

describe("useAssistants", () => {
    beforeEach(() => {
        vi.spyOn(LoggerFactory.getLogger("PT/useAssistants"), "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("lifts three fields off each Assistant", async () => {
        install(TWO);

        const { result } = renderHook(() => useAssistants());

        await waitFor(() => expect(result.current.state).toBe("ready"));
        expect(result.current.state === "ready" && result.current.assistants).toEqual([
            { key: "receptionist", name: "Receptionist", enabled: true },
            { key: "accountant", name: "Accountant", enabled: false }
        ]);
    });

    it("keeps no part of the document body — not the prompt, not a Skill", async () => {
        install(TWO);

        const { result } = renderHook(() => useAssistants());

        await waitFor(() => expect(result.current.state).toBe("ready"));
        const held = JSON.stringify(result.current);
        expect(held).not.toContain("prompt");
        expect(held).not.toContain("markdown");
        expect(held).not.toContain("SkillName");
    });

    it("sorts by Name, with all four fields the server insists on", async () => {
        install(TWO);

        renderHook(() => useAssistants());

        await waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0]?.params.query["sort"]).toEqual([
            { field: "/Assistant/Name", direction: "ASC", nullHandling: "NULLS_LAST", ignoreCase: true }
        ]);
    });

    it("asks for one page of Assistants and nothing else", async () => {
        install(TWO);

        renderHook(() => useAssistants());

        await waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0]?.method).toBe("QUERY");
        expect(sent[0]?.params.query["targetDocumentModel"]).toBe("Assistant_DM");
        expect(sent[0]?.params.query["paging"]).toEqual({ pageNumber: 0, pageSize: 25 });
    });

    it("takes total from fullSize, which may exceed the page it was given", async () => {
        install(TWO, 7);

        const { result } = renderHook(() => useAssistants());

        await waitFor(() => expect(result.current.state).toBe("ready"));
        expect(result.current.state === "ready" && result.current.total).toBe(7);
        expect(result.current.state === "ready" && result.current.assistants).toHaveLength(2);
    });

    it("stamps the instant it read, because the Tile says so on screen", async () => {
        install(TWO);

        const { result } = renderHook(() => useAssistants());

        await waitFor(() => expect(result.current.state).toBe("ready"));
        expect(result.current.state === "ready" && result.current.readAt).toBeInstanceOf(Date);
    });

    it("says error, and throws nothing, when the read fails", async () => {
        install(TWO, 2, false);

        const { result } = renderHook(() => useAssistants());

        await waitFor(() => expect(result.current.state).toBe("error"));
    });

    it("is ready with nothing in it when there are no Assistants at all", async () => {
        install([], 0);

        const { result } = renderHook(() => useAssistants());

        await waitFor(() => expect(result.current.state).toBe("ready"));
        expect(result.current.state === "ready" && result.current.total).toBe(0);
    });

    it("skips an entry that carries no name rather than rendering a nameless robot", async () => {
        install([entry("receptionist", "Receptionist", true), { type: "ROOT", docRef: "x", document: {} }]);

        const { result } = renderHook(() => useAssistants());

        await waitFor(() => expect(result.current.state).toBe("ready"));
        expect(result.current.state === "ready" && result.current.assistants).toHaveLength(1);
    });

    it("reads once on mount and does not poll", async () => {
        install(TWO);

        const { result, rerender } = renderHook(() => useAssistants());
        await waitFor(() => expect(result.current.state).toBe("ready"));

        rerender();
        expect(sent).toHaveLength(1);
    });
});
