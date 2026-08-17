import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { monthBuckets } from "../../../components/dashboard/buckets";
import type { ThingCounts } from "../../../components/dashboard/useThingCounts";
import { OPEN_MODULE } from "../../../sagas/openModule";

import { Frame, recordingStore } from "../conversation/harness";

/**
 * Two halves. The **curve** is asserted on the pure functions that build it, because a Recharts
 * `ResponsiveContainer` has no size in jsdom and renders nothing there — the browser check in phase D is
 * what proves it draws. Everything else is asserted on the rendered Tile.
 */

const counts = vi.hoisted(() => ({ current: { state: "loading" } as ThingCounts }));

vi.mock("../../../components/dashboard/useThingCounts", () => ({
    useThingCounts: () => counts.current
}));

const { DocumentsTile, createdOnLag, documentCurve, documentQueries } =
    await import("../../../components/dashboard/DocumentsTile");

const LADDER = monthBuckets(new Date("2026-08-17T09:12:33Z"));

/** Two Documents in each of the twelve months, and five before the window opened. */
const MONTHLY: Record<string, number> = { before: 5, ...Object.fromEntries(LADDER.months.map((m) => [m.key, 2])) };

function ready(extra: Record<string, number>): ThingCounts {
    return { state: "ready", counts: { ...MONTHLY, ...extra }, readAt: new Date("2026-08-17T14:32:07") };
}

function renderTile(state: ThingCounts, store = recordingStore()) {
    counts.current = state;
    render(
        <Frame store={store.store}>
            <DocumentsTile />
        </Frame>
    );
    return store;
}

describe("documentQueries", () => {
    it("asks for one total and thirteen windows, in one list", () => {
        const queries = documentQueries(LADDER);

        expect(queries).toHaveLength(14);
        expect(queries[0]).toEqual({ key: "total", model: "Document_DM" });
        expect(queries[1]?.constraint).toEqual({
            operator: "date_range",
            field: "/Document/CreatedAt",
            to: LADDER.before.to
        });
        expect(queries.every((query) => query.model === "Document_DM")).toBe(true);
    });

    it("gives the baseline no lower bound, because there is nothing below it", () => {
        expect(documentQueries(LADDER)[1]?.constraint).not.toHaveProperty("from");
    });
});

describe("documentCurve", () => {
    it("cumulates the baseline with the twelve months, in order, twelve points long", () => {
        const curve = documentCurve(LADDER, MONTHLY);

        expect(curve).toHaveLength(12);
        expect(curve.map((point) => point.documents)).toEqual([7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29]);
        expect(curve[0]?.label).toBe("Sep 2025");
        expect(curve[11]?.label).toBe("Aug 2026");
    });

    it("never goes down, which is what makes it a curve of what existed", () => {
        const curve = documentCurve(LADDER, { ...MONTHLY, m4: 0, m5: 0 });

        for (let i = 1; i < curve.length; i++) {
            expect(curve[i]!.documents).toBeGreaterThanOrEqual(curve[i - 1]!.documents);
        }
    });
});

describe("createdOnLag", () => {
    it("is the gap between what exists and what the curve could show", () => {
        expect(createdOnLag(31, documentCurve(LADDER, MONTHLY))).toBe(2);
    });

    it("is nothing when the two agree", () => {
        expect(createdOnLag(29, documentCurve(LADDER, MONTHLY))).toBe(0);
    });
});

describe("DocumentsTile", () => {
    beforeEach(() => {
        counts.current = { state: "loading" };
    });

    it("headlines how many Documents exist, which is the unconstrained count", () => {
        renderTile(ready({ total: 31 }));

        expect(screen.getByTestId("tile-documents-headline")).toHaveTextContent("31");
    });

    it("states the createdOn lag when the headline runs ahead of the curve", () => {
        renderTile(ready({ total: 31 }));

        expect(screen.getByTestId("tile-documents-lag")).toHaveTextContent("2 not yet stamped");
    });

    it("says nothing about a lag when there is none", () => {
        renderTile(ready({ total: 29 }));

        expect(screen.queryByTestId("tile-documents-lag")).not.toBeInTheDocument();
    });

    it("opens the Documents module when it is clicked", () => {
        const store = renderTile(ready({ total: 29 }));

        fireEvent.click(screen.getByText("Documents"));

        expect(store.actions).toEqual([{ type: OPEN_MODULE, payload: { module: "Document" } }]);
    });

    it("says it could not read rather than drawing a flat line it did not measure", () => {
        renderTile({ state: "error" });

        expect(screen.getByTestId("tile-documents")).toHaveAttribute("data-state", "error");
        expect(screen.queryByTestId("tile-documents-curve")).not.toBeInTheDocument();
    });
});
