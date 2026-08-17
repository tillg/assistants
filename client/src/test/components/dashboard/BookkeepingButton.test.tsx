import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { ConnectorLocator, type ServerConnector } from "@com.mgmtp.a12.utils/utils-connector";

import { BookkeepingButton } from "../../../components/dashboard/BookkeepingButton";

import { Frame } from "../conversation/harness";

/**
 * The door that asks nothing. Its test is mostly about what is *absent*: no number, no read instant,
 * no body — and the assertion that matters — no request at all.
 */

let asked = 0;

function renderButton() {
    asked = 0;
    ConnectorLocator.createInstance({
        fetchData: () => {
            asked++;
            return Promise.reject(new Error("the bookkeeping door must not ask the store anything"));
        }
    } as unknown as ServerConnector);

    return render(
        <Frame>
            <BookkeepingButton />
        </Frame>
    );
}

describe("BookkeepingButton", () => {
    it("is an anchor to Firefly, opened safely in a new tab", () => {
        renderButton();

        const anchor = screen.getByRole("link", { name: /Bookkeeping/ });
        expect(anchor).toHaveAttribute("href", "http://localhost:8084");
        expect(anchor).toHaveAttribute("target", "_blank");
        expect(anchor).toHaveAttribute("rel", "noopener noreferrer");
    });

    it("issues no query — it is a way in, not a summary", () => {
        renderButton();

        expect(asked).toBe(0);
    });

    it("is drawn as a control, not as a Tile with a missing number", () => {
        renderButton();

        expect(screen.getByTestId("tile-bookkeeping")).toHaveAttribute("data-variant", "button");
    });

    it("shows none of the three slots, because it has nothing to put in them", () => {
        renderButton();

        expect(screen.queryByTestId("tile-bookkeeping-headline")).not.toBeInTheDocument();
        expect(screen.queryByTestId("tile-bookkeeping-body")).not.toBeInTheDocument();
        expect(screen.queryByTestId("tile-bookkeeping-footer")).not.toBeInTheDocument();
    });

    it("is permanently ready — it has nothing to load and nothing that can fail", () => {
        renderButton();

        expect(screen.getByTestId("tile-bookkeeping")).toHaveAttribute("data-state", "ready");
        expect(screen.queryByTestId("tile-bookkeeping-headline-placeholder")).not.toBeInTheDocument();
    });
});
