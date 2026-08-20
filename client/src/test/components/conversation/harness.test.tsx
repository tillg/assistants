import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, renderHook, waitFor } from "@testing-library/react";
import { useStore } from "react-redux";
import type { Store } from "redux";

import { LoggerFactory } from "@com.mgmtp.a12.utils/utils-logging";

import { resetThingByIdCache, useThingById } from "../../../components/conversation/useThingById";

import { Frame, serveDocuments } from "./harness";

/**
 * The harness's own two promises, tested because everything else in this folder rests on them and
 * neither is visible from a test that only uses them: a `Frame` with no store of its own keeps one
 * store, and a test is never served by the server the test before it installed.
 */

const QUESTION = { OpenQuestion: { Prompt: "Book it?" } };

describe("Frame", () => {
    it("keeps one store across re-renders when the test passed none", () => {
        const seen: Store[] = [];

        function Probe() {
            seen.push(useStore());
            return null;
        }

        const { rerender } = render(
            <Frame>
                <Probe />
            </Frame>
        );
        rerender(
            <Frame>
                <Probe />
            </Frame>
        );

        // Built inside the JSX, the fallback store was a new one on every render: `Provider` re-subscribed
        // each time and threw away what the last render had recorded — which is the one thing this
        // harness says it does.
        expect(seen).toHaveLength(2);
        expect(new Set(seen).size).toBe(1);
    });
});

describe("the installed server", () => {
    beforeEach(() => {
        resetThingByIdCache();
        vi.spyOn(LoggerFactory.getLogger("PT/useThingById"), "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("answers with the document the test told it to hold", async () => {
        serveDocuments({ "OpenQuestion_DM/45e95914": QUESTION });

        const { result } = renderHook(() => useThingById("OpenQuestion_DM", "45e95914"));

        await waitFor(() => expect(result.current.state).toBe("ready"));
    });

    /**
     * Second on purpose, and installing nothing on purpose. `ConnectorLocator` is a singleton with no way
     * to uninstall what was put in it, so before `vitest.setup.ts` began resetting it this read was
     * answered by the test above and came back `ready` — a test passing on its neighbour's table.
     */
    it("is not the one the test before it installed", async () => {
        const { result } = renderHook(() => useThingById("OpenQuestion_DM", "45e95914"));

        await waitFor(() => expect(result.current.state).toBe("nothing"));
    });
});
