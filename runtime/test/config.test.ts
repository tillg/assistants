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
        //
        // Supplying THINGSTORE_PASSWORD here is the point of the test above, seen from the other
        // side: every caller of `loadConfig` must now have it, which is why the justfile passes it
        // to the host recipes.
        process.env["THINGSTORE_PASSWORD"] = "supplied-by-the-caller";
        try {
            const config = withoutEnv("BOOTSTRAP_PASSWORD", () => loadConfig());
            expect(config.bootstrapPassword).toBe("human");
        } finally {
            delete process.env["THINGSTORE_PASSWORD"];
        }
    });

    it("keeps the door outward shut unless a port is configured", () => {
        // The inbox is an addition to the Runtime's job, not part of it (ADR-0023). A deployment that
        // does not want it should not have to know the setting exists.
        process.env["THINGSTORE_PASSWORD"] = "supplied-by-the-caller";
        try {
            const config = withoutEnv("INBOUND_PORT", () => loadConfig());
            expect(config.inboundPort).toBe(0);
            expect(config.inboundSecret).toBe("");
        } finally {
            delete process.env["THINGSTORE_PASSWORD"];
        }
    });

    it("refuses to open the door outward without a secret", () => {
        // The one listener in this system that can execute an Operation. Starting it with an empty
        // default would be a door that opens quietly, so this fails at startup instead.
        process.env["THINGSTORE_PASSWORD"] = "supplied-by-the-caller";
        process.env["INBOUND_PORT"] = "8090";
        try {
            withoutEnv("INBOUND_SECRET", () => {
                expect(() => loadConfig()).toThrow(/INBOUND_SECRET/);
            });
        } finally {
            delete process.env["THINGSTORE_PASSWORD"];
            delete process.env["INBOUND_PORT"];
        }
    });

    it("admits nothing through the door until something is named", () => {
        // An empty allowlist is the right default for a list that grants access — unset means "no
        // Operation is callable", never "every Operation is".
        process.env["THINGSTORE_PASSWORD"] = "supplied-by-the-caller";
        try {
            expect(withoutEnv("CLIENT_CALLABLE_OPERATIONS", () => loadConfig()).clientCallable).toEqual([]);

            process.env["CLIENT_CALLABLE_OPERATIONS"] = " bookkeeping.listAccounts , ,bookkeeping.listTransactions ";
            expect(loadConfig().clientCallable).toEqual([
                "bookkeeping.listAccounts",
                "bookkeeping.listTransactions",
            ]);
        } finally {
            delete process.env["THINGSTORE_PASSWORD"];
            delete process.env["CLIENT_CALLABLE_OPERATIONS"];
        }
    });

    it("reads schedules in one configured timezone, defaulting to the household's own", () => {
        // Not a secret, so a default belongs in the code — but it is load-bearing twice a year
        // (ADR-0016), so it is worth an assertion that says which default was chosen deliberately.
        process.env["THINGSTORE_PASSWORD"] = "supplied-by-the-caller";
        try {
            expect(withoutEnv("SCHEDULE_TIMEZONE", () => loadConfig()).scheduleTimezone).toBe(
                "Europe/Berlin",
            );
            process.env["SCHEDULE_TIMEZONE"] = "UTC";
            expect(loadConfig().scheduleTimezone).toBe("UTC");
        } finally {
            delete process.env["THINGSTORE_PASSWORD"];
            delete process.env["SCHEDULE_TIMEZONE"];
        }
    });
});
