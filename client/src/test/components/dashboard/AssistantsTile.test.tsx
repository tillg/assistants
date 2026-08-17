import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import type { Assistants } from "../../../components/dashboard/useAssistants";
import { ICONS } from "../../../components/icons";
import { OPEN_MODULE } from "../../../sagas/openModule";

import { Frame, recordingStore } from "../conversation/harness";

const assistants = vi.hoisted(() => ({ current: { state: "loading" } as Assistants }));

vi.mock("../../../components/dashboard/useAssistants", () => ({
    useAssistants: () => assistants.current
}));

const { AssistantsTile } = await import("../../../components/dashboard/AssistantsTile");

const TWO: Assistants = {
    state: "ready",
    assistants: [
        { key: "accountant", name: "Accountant", enabled: true },
        { key: "receptionist", name: "Receptionist", enabled: false }
    ],
    total: 2,
    readAt: new Date("2026-08-17T14:32:07")
};

function renderTile(state: Assistants, store = recordingStore()) {
    assistants.current = state;
    render(
        <Frame store={store.store}>
            <AssistantsTile />
        </Frame>
    );
    return store;
}

describe("AssistantsTile", () => {
    beforeEach(() => {
        assistants.current = { state: "loading" };
    });

    it("headlines how many there are", () => {
        renderTile(TWO);

        expect(screen.getByTestId("tile-assistants-headline")).toHaveTextContent("2");
    });

    it("names each of them, with the 🤖 the icon vocabulary already has", () => {
        renderTile(TWO);

        const names = screen.getAllByTestId("tile-assistants-name");
        expect(names.map((name) => name.textContent)).toEqual([
            `${ICONS.assistant} Accountant`,
            `${ICONS.assistant} Receptionist — disabled`
        ]);
    });

    it("says so when one is disabled, rather than hiding it", () => {
        renderTile(TWO);

        expect(screen.getByText(/Receptionist — disabled/)).toBeInTheDocument();
    });

    it("appends 'and N more' when the page is shorter than the total", () => {
        renderTile({ ...TWO, total: 5 });

        expect(screen.getByTestId("tile-assistants-more")).toHaveTextContent("and 3 more");
    });

    it("says nothing of the sort when the page is the whole set", () => {
        renderTile(TWO);

        expect(screen.queryByTestId("tile-assistants-more")).not.toBeInTheDocument();
    });

    it("opens the Assistants module when it is clicked", () => {
        const store = renderTile(TWO);

        fireEvent.click(screen.getByText("Assistants"));

        expect(store.actions).toEqual([{ type: OPEN_MODULE, payload: { module: "Assistant" } }]);
    });

    it("says it could not read rather than showing an empty staff", () => {
        renderTile({ state: "error" });

        expect(screen.getByTestId("tile-assistants")).toHaveAttribute("data-state", "error");
        expect(screen.queryByTestId("tile-assistants-name")).not.toBeInTheDocument();
    });
});
