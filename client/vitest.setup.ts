import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

import { ConnectorLocator, type ServerConnector } from "@com.mgmtp.a12.utils/utils-connector";

// React Testing Library does not auto-clean up without global test hooks; unmount between tests explicitly.
afterEach(cleanup);

// `ConnectorLocator` is a singleton the platform reads through, and it offers no way to uninstall what
// was installed — so a test that reads a document without saying what the server answers would be served
// by whichever test ran before it, and would pass or fail on its neighbour's table. Every test therefore
// begins with a server that refuses, and a missing `serveRpc` fails as itself rather than as a mystery.
beforeEach(() => {
    ConnectorLocator.createInstance({
        fetchData: () => Promise.reject(new Error("No server is installed; call serveRpc or serveDocuments."))
    } as unknown as ServerConnector);
});

// jsdom has no ResizeObserver, and the widget library's auto-expanding inputs ask for one on mount.
// A stub that observes nothing is right for a layout nothing measures: without it the rich-text editor
// floods the run with a warning it can do nothing about.
if (!("ResizeObserver" in globalThis)) {
    globalThis.ResizeObserver = class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    } as unknown as typeof ResizeObserver;
}
