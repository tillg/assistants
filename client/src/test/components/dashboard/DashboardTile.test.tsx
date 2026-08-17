import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { DashboardTile } from "../../../components/dashboard/DashboardTile";

import { Frame } from "../conversation/harness";

/**
 * The chrome, and only the chrome: the three states, and the three **optional** slots. A Tile that
 * supplies no headline and no footer — the bookkeeping one — must still be a valid Tile, which is the
 * whole reason those slots are optional rather than a second chrome existing for one Tile.
 */

function renderTile(props: Partial<Parameters<typeof DashboardTile>[0]> = {}) {
    return render(
        <Frame>
            <DashboardTile role="tile-test" icon="🗣" title="Conversations" state="ready" {...props} />
        </Frame>
    );
}

describe("DashboardTile", () => {
    it("says which state it is in, so a spec can wait on it rather than sleep", () => {
        renderTile({ state: "loading" });

        expect(screen.getByTestId("tile-test")).toHaveAttribute("data-state", "loading");
    });

    it("shows its icon and title while loading, and a placeholder where the headline goes", () => {
        renderTile({ state: "loading", headline: "7" });

        expect(screen.getByText("Conversations")).toBeInTheDocument();
        expect(screen.getByText("🗣")).toBeInTheDocument();
        expect(screen.queryByText("7")).not.toBeInTheDocument();
        expect(screen.getByTestId("tile-test-headline-placeholder")).toBeInTheDocument();
    });

    it("shows the slots it was given when it is ready", () => {
        renderTile({ headline: "7", body: <p>three lines</p>, footer: "as of 14:32" });

        expect(screen.getByText("7")).toBeInTheDocument();
        expect(screen.getByText("three lines")).toBeInTheDocument();
        expect(screen.getByText("as of 14:32")).toBeInTheDocument();
    });

    it("is a valid Tile with no headline and no footer, because one Tile has neither", () => {
        renderTile({ body: <p>opens in a new tab</p> });

        expect(screen.getByTestId("tile-test")).toHaveAttribute("data-state", "ready");
        expect(screen.getByText("opens in a new tab")).toBeInTheDocument();
        expect(screen.queryByTestId("tile-test-headline")).not.toBeInTheDocument();
        expect(screen.queryByTestId("tile-test-footer")).not.toBeInTheDocument();
    });

    it("shows one line, and none of the slots, when it could not read", () => {
        renderTile({ state: "error", headline: "7", body: <p>three lines</p>, footer: "as of 14:32" });

        expect(screen.getByTestId("tile-test")).toHaveAttribute("data-state", "error");
        expect(screen.getByText("could not read this")).toBeInTheDocument();
        expect(screen.queryByText("7")).not.toBeInTheDocument();
        expect(screen.queryByText("three lines")).not.toBeInTheDocument();
        expect(screen.getByText("Conversations")).toBeInTheDocument();
    });

    it("opens what it was told to open when it is clicked", () => {
        const onOpen = vi.fn();
        renderTile({ onOpen });

        fireEvent.click(screen.getByText("Conversations"));

        expect(onOpen).toHaveBeenCalledOnce();
    });

    it("is a real anchor when it points outside the application, with the rel that makes that safe", () => {
        renderTile({ href: "http://localhost:8084", title: "Bookkeeping", icon: "💰" });

        const anchor = screen.getByRole("link", { name: /Bookkeeping/ });
        expect(anchor).toHaveAttribute("href", "http://localhost:8084");
        expect(anchor).toHaveAttribute("target", "_blank");
        expect(anchor).toHaveAttribute("rel", "noopener noreferrer");
    });

    it("says which variant it is, because a control and a summary are not the same thing on screen", () => {
        renderTile();

        expect(screen.getByTestId("tile-test")).toHaveAttribute("data-variant", "tile");

        renderTile({ variant: "button" });

        expect(screen.getAllByTestId("tile-test")[1]).toHaveAttribute("data-variant", "button");
    });

    it("drops all three slots in the button variant — a control has nothing to summarise", () => {
        renderTile({
            variant: "button",
            headline: "7",
            body: <p>three lines</p>,
            footer: "as of 14:32"
        });

        expect(screen.queryByTestId("tile-test-headline")).not.toBeInTheDocument();
        expect(screen.queryByTestId("tile-test-body")).not.toBeInTheDocument();
        expect(screen.queryByTestId("tile-test-footer")).not.toBeInTheDocument();
        expect(screen.getByText("Conversations")).toBeInTheDocument();
    });

    it("is still a real anchor in the button variant, which is the whole of what it does", () => {
        renderTile({
            variant: "button",
            href: "http://localhost:8084",
            title: "Bookkeeping",
            icon: "💰"
        });

        const anchor = screen.getByRole("link", { name: /Bookkeeping/ });
        expect(anchor).toHaveAttribute("href", "http://localhost:8084");
        expect(anchor).toHaveAttribute("target", "_blank");
        expect(anchor).toHaveAttribute("rel", "noopener noreferrer");
    });
});
