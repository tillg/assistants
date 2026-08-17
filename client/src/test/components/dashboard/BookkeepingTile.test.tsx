import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { ConnectorLocator, type ServerConnector } from "@com.mgmtp.a12.utils/utils-connector";

import { BookkeepingTile } from "../../../components/dashboard/BookkeepingTile";

import { Frame } from "../conversation/harness";

/**
 * The Tile that asks nothing. Its test is mostly about what is *absent*: no number, no read instant, and
 * — the assertion that matters — no request at all.
 */

let asked = 0;

function renderTile() {
    asked = 0;
    ConnectorLocator.createInstance({
        fetchData: () => {
            asked++;
            return Promise.reject(new Error("the bookkeeping Tile must not ask the store anything"));
        }
    } as unknown as ServerConnector);

    return render(
        <Frame>
            <BookkeepingTile />
        </Frame>
    );
}

describe("BookkeepingTile", () => {
    it("is an anchor to Firefly, opened safely in a new tab", () => {
        renderTile();

        const anchor = screen.getByRole("link", { name: /Bookkeeping/ });
        expect(anchor).toHaveAttribute("href", "http://localhost:8084");
        expect(anchor).toHaveAttribute("target", "_blank");
        expect(anchor).toHaveAttribute("rel", "noopener noreferrer");
    });

    it("issues no query, because the fact it would show belongs to another Authority", () => {
        renderTile();

        expect(asked).toBe(0);
    });

    it("shows no headline and no footer, and is a Tile anyway", () => {
        renderTile();

        expect(screen.getByTestId("tile-bookkeeping")).toHaveAttribute("data-state", "ready");
        expect(screen.queryByTestId("tile-bookkeeping-headline")).not.toBeInTheDocument();
        expect(screen.queryByTestId("tile-bookkeeping-footer")).not.toBeInTheDocument();
        expect(screen.getByTestId("tile-bookkeeping-body")).toBeInTheDocument();
    });

    it("is permanently ready — it has nothing to load and nothing that can fail", () => {
        renderTile();

        expect(screen.getByTestId("tile-bookkeeping")).toHaveAttribute("data-state", "ready");
        expect(screen.queryByTestId("tile-bookkeeping-headline-placeholder")).not.toBeInTheDocument();
    });
});
