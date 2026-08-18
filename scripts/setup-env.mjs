#!/usr/bin/env node
/**
 * Writes `.env` from `.env.example`, replacing every CHANGE_ME_GENERATED with fresh randomness.
 *
 * Node rather than shell: this needs in-place editing and random generation in specific shapes,
 * and `sed -i` takes different arguments on macOS and Linux while `envsubst` is absent on macOS.
 * Node is already a hard dependency of both the Runtime and the client.
 *
 * Run through `just setup`.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = join(REPO_ROOT, ".env");
const EXAMPLE_FILE = join(REPO_ROOT, ".env.example");

const PLACEHOLDER = "CHANGE_ME_GENERATED";

/**
 * How each generated value is shaped. Three of them are not free-form:
 *
 *   - FIREFLY_APP_KEY      Laravel wants `base64:` followed by exactly 32 bytes.
 *   - FIREFLY_CRON_TOKEN   Firefly rejects anything that is not exactly 32 characters.
 *   - FIREFLY_PROXY_COOKIE_SECRET  oauth2-proxy accepts 16, 24 or 32 bytes and nothing else.
 *
 * The rest are ordinary passwords, kept alphanumeric so nothing downstream has to worry about
 * quoting them in a URL, a connection string or a shell.
 */
const SHAPES = {
    FIREFLY_APP_KEY: () => `base64:${randomBytes(32).toString("base64")}`,
    FIREFLY_CRON_TOKEN: () => randomBytes(16).toString("hex"),
    FIREFLY_PROXY_COOKIE_SECRET: () => randomBytes(16).toString("hex")
};

const password = () => randomBytes(24).toString("base64url").slice(0, 28);

if (existsSync(ENV_FILE)) {
    // Not politeness. The database passwords are baked into the Postgres volume when it is first
    // created, so regenerating them on a stack that has already run locks the server out of its
    // own data until `just clean` drops the volume.
    console.log(".env already exists — leaving it alone.");
    console.log("  To start over: rm .env && just clean && just setup");
    process.exit(0);
}

let text = readFileSync(EXAMPLE_FILE, "utf8");
const generated = [];

text = text.replace(new RegExp(`^([A-Z0-9_]+)='${PLACEHOLDER}'$`, "gm"), (_match, name) => {
    const value = (SHAPES[name] ?? password)();
    generated.push(name);
    return `${name}='${value}'`;
});

// Only assignments count. The header of .env.example explains what CHANGE_ME_GENERATED means, and
// that prose must not read as an unsubstituted value.
const leftover = text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#") && line.includes(PLACEHOLDER));

// Validate BEFORE writing. Writing a poisoned .env first and exiting 1 afterwards left the broken
// file on disk, and the next run's "already exists — leaving it alone" guard then made it permanent
// until a manual `rm .env`. `render.mjs` writes nothing until it all substitutes cleanly; so does this.
if (leftover.length > 0) {
    // A CHANGE_ME_GENERATED that did not match the `NAME='...'` shape above — a malformed example.
    console.error(`.env.example still contains ${PLACEHOLDER} on:`);
    for (const line of leftover) console.error(`  ${line}`);
    console.error("\nRefusing to write a poisoned .env. Fix .env.example and re-run.");
    process.exit(1);
}

writeFileSync(ENV_FILE, text);

console.log(`wrote .env from .env.example, generating ${generated.length} credentials:`);
for (const name of generated) console.log(`  ${name}`);
