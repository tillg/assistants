import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { LoggerFactory } from "@com.mgmtp.a12.utils/utils-logging";

import { ThingLink } from "../../components/ThingLink";
import { resetThingByIdCache } from "../../components/conversation/useThingById";

import { Frame, recordingStore, serveDocuments } from "./conversation/harness";

/**
 * The one way the system names a Thing: title + Model in brackets, always a link, opening a read-only
 * summary of the Thing in a popup — read in place, never a navigation. The popup host comes from the
 * harness `Frame`.
 */

const INVOICE = { Invoice: { IssuerName: "Acme GmbH", InvoiceNumber: "2024-0417" } };
const INVOICE_REF = "Invoice_DM/a3f9c1de-0000-4000-8000-000000000001";
const INVOICE_ID = "a3f9c1de-0000-4000-8000-000000000001";

function renderLink(store = recordingStore()) {
    render(
        <Frame store={store.store}>
            <ThingLink model="Invoice_DM" thingId={INVOICE_ID} />
        </Frame>
    );
    return store;
}

describe("ThingLink", () => {
    beforeEach(() => {
        resetThingByIdCache();
        vi.spyOn(LoggerFactory.getLogger("PT/useThingById"), "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("names the Thing by its composed title and its Model in brackets", async () => {
        serveDocuments({ [INVOICE_REF]: INVOICE });

        renderLink();

        await waitFor(() => expect(screen.getByTestId("thing-link")).toHaveTextContent("Acme GmbH · #2024-0417"));
        expect(screen.getByTestId("thing-link")).toHaveTextContent("(Invoice)");
    });

    it("is always a link, and falls back to a short id before the Thing has loaded", () => {
        serveDocuments({ [INVOICE_REF]: INVOICE });

        renderLink();

        // Rendered as a link from the first frame, on the short id, before the read resolves.
        const link = screen.getByTestId("thing-link");
        expect(link.tagName).toBe("BUTTON");
        expect(link).toHaveTextContent("a3f9c1de (Invoice)");
    });

    it("opens a read-only summary of the Thing in a popup on click", async () => {
        serveDocuments({ [INVOICE_REF]: INVOICE });
        renderLink();

        expect(screen.queryByTestId("thing-summary")).toBeNull();
        fireEvent.click(screen.getByTestId("thing-link"));

        // The Thing's identity leads the summary, and its own fields follow.
        await waitFor(() =>
            expect(screen.getByTestId("thing-summary-title")).toHaveTextContent("Acme GmbH · #2024-0417 (Invoice)")
        );
        const summary = screen.getByTestId("thing-summary");
        expect(summary).toHaveTextContent("IssuerName");
        expect(summary).toHaveTextContent("Acme GmbH");
        expect(summary).toHaveTextContent("2024-0417");
        // Read-only: it is text, not a form — reads may cross documents, writes may not.
        expect(summary.querySelectorAll("input, textarea, select")).toHaveLength(0);
    });

    it("says so, rather than blanking, when the Thing cannot be read", async () => {
        serveDocuments({}); // the docRef is not served — a rejected read

        renderLink();
        fireEvent.click(screen.getByTestId("thing-link"));

        // The heading still shows the short id + Model; the body reports it could not be read.
        await waitFor(() => expect(screen.getByTestId("thing-summary")).toHaveTextContent("could not be read"));
        expect(screen.getByTestId("thing-summary-title")).toHaveTextContent("a3f9c1de (Invoice)");
    });

    it("dismisses the popup on Escape, in place", async () => {
        serveDocuments({ [INVOICE_REF]: INVOICE });
        renderLink();

        fireEvent.click(screen.getByTestId("thing-link"));
        await waitFor(() => expect(screen.getByTestId("thing-summary")).toBeInTheDocument());

        // The overlay's Esc handler only fires for a keydown originating inside its own portal.
        fireEvent.keyDown(screen.getByTestId("thing-summary"), { key: "Escape", code: "Escape" });

        await waitFor(() => expect(screen.queryByTestId("thing-summary")).toBeNull());
    });
});
