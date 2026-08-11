/**
 * What the Runtime refuses to guess.
 *
 * D-023 put every secret in one gitignored `.env`. A default in the code is a second copy of a
 * secret, and a second copy is only ever right until someone changes the first one — at which
 * point the Runtime authenticates with the old value and fails at its first authenticated call
 * rather than at startup, which is the worst place to find out.
 */

import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

/** `loadConfig` reads `process.env` directly, so the variable has to be moved out of the way. */
function withoutEnv<T>(name: string, body: () => T): T {
    const previous = process.env[name];
    delete process.env[name];
    try {
        return body();
    } finally {
        if (previous !== undefined) process.env[name] = previous;
    }
}

describe("configuration", () => {
    it("refuses to start without a ThingStore password rather than falling back to a literal", () => {
        withoutEnv("THINGSTORE_PASSWORD", () => {
            expect(() => loadConfig()).toThrow(/THINGSTORE_PASSWORD/);
        });
    });

    it("still has development fallbacks for the logins README publishes", () => {
        // The counter-case, so the rule above is not read as "no defaults anywhere". `human`/`human`
        // is quoted in README as the way to sign in and is deliberately not generated (D-023), so a
        // default for it is honest. The distinction is whether `.env` is the only source of truth.
        const config = withoutEnv("BOOTSTRAP_PASSWORD", () => loadConfig());
        expect(config.bootstrapPassword).toBe("human");
    });
});
