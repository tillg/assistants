import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// React Testing Library does not auto-clean up without global test hooks; unmount between tests explicitly.
afterEach(cleanup);

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
