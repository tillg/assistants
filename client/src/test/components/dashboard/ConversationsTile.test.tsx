import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import type { ThingCounts } from "../../../components/dashboard/useThingCounts";
import { OPEN_MODULE } from "../../../sagas/openModule";

import { Frame, recordingStore } from "../conversation/harness";

/**
 * The Tile over a stubbed hook: what it *asks* is `useThingCounts`' test, and what it *shows* is this
 * one. The hook is stubbed rather than served, so a broken constraint cannot make this suite green by
 * accident — that is what the e2e assertion against the Conversations overview is for.
 */

const counts = vi.hoisted(() => ({ current: { state: "loading" } as ThingCounts }));

vi.mock("../../../components/dashboard/useThingCounts", () => ({
    useThingCounts: () => counts.current
}));

const { ConversationsTile } = await import("../../../components/dashboard/ConversationsTile");

const READY: ThingCounts = {
    state: "ready",
    counts: { running: 1, waitingOnUser: 4, waitingOnOther: 2 },
    readAt: new Date("2026-08-17T14:32:07")
};

function renderTile(state: ThingCounts, store = recordingStore()) {
    counts.current = state;
    render(
        <Frame store={store.store}>
            <ConversationsTile />
        </Frame>
    );
    return store;
}

describe("ConversationsTile", () => {
    beforeEach(() => {
        counts.current = { state: "loading" };
    });

    it("headlines the In flight sum, which is all three counts and not one of them", () => {
        renderTile(READY);

        expect(screen.getByTestId("tile-conversations-headline")).toHaveTextContent("7 in flight");
    });

    it("breaks the sum down into the three lines a User can act on", () => {
        renderTile(READY);

        expect(screen.getByTestId("tile-conversations-running")).toHaveTextContent("1 running");
        expect(screen.getByTestId("tile-conversations-waiting-on-you")).toHaveTextContent("4 waiting on you");
        expect(screen.getByTestId("tile-conversations-waiting")).toHaveTextContent("2 waiting");
    });

    it("states the instant it read, because nothing here polls", () => {
        renderTile(READY);

        expect(screen.getByTestId("tile-conversations-footer")).toHaveTextContent("as of 14:32");
    });

    it("opens the Conversations module when it is clicked", () => {
        const store = renderTile(READY);

        fireEvent.click(screen.getByText("Conversations"));

        expect(store.actions).toEqual([{ type: OPEN_MODULE, payload: { module: "Conversation" } }]);
    });

    it("shows no number at all while it is loading", () => {
        renderTile({ state: "loading" });

        expect(screen.getByTestId("tile-conversations")).toHaveAttribute("data-state", "loading");
        expect(screen.queryByTestId("tile-conversations-headline")).not.toBeInTheDocument();
    });

    it("says it could not read, rather than showing a zero it did not count", () => {
        renderTile({ state: "error" });

        expect(screen.getByTestId("tile-conversations")).toHaveAttribute("data-state", "error");
        expect(screen.getByTestId("tile-conversations-error")).toBeInTheDocument();
        expect(screen.queryByText(/in flight/)).not.toBeInTheDocument();
    });
});
