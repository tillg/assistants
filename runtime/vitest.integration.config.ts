import { defineConfig } from "vitest/config";

/**
 * The integration tier: everything here talks to the *running* stack.
 *
 * The files are named `*.itest.ts` rather than `*.test.ts` on purpose — Vitest's default
 * `include` only matches `*.test.ts`, so `npm test` (the unit tier) never even collects these
 * and stays fast without a second config file having to exclude them.
 */
export default defineConfig({
    test: {
        include: ["test/integration/**/*.itest.ts"],
        // One file at a time: these share one ThingStore and one Firefly instance, and the
        // idempotency assertions would be meaningless if two files raced on the same demo data.
        fileParallelism: false,
        sequence: { concurrent: false },
        testTimeout: 60_000,
        hookTimeout: 60_000,
        reporters: ["verbose"],
    },
});
