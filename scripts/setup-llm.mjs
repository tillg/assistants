#!/usr/bin/env node
/**
 * Writes `llm.json` from `llm.json.example`, once, and never touches it again.
 *
 * The same split as `.env` and for the same reason (D-023, D-057): the sample is committed so a
 * clone knows what a profile looks like, and the working copy is gitignored so that switching
 * model — which is one line, `active` — is a local act and not a change to the repository.
 *
 * It holds no secret, so unlike `.env` there is nothing to generate; the copy is the whole job.
 *
 * Run through `just setup`, and again from `just up`: compose bind-mounts this file into the
 * Runtime container, and a bind mount whose source is missing is silently created **as a
 * directory** — which the Runtime then fails to read, with an error about the wrong thing.
 */
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(REPO_ROOT, "llm.json");
const SAMPLE = join(REPO_ROOT, "llm.json.example");

if (existsSync(TARGET)) {
    // Silent on purpose: `just up` calls this every time, and it has nothing to report.
    process.exit(0);
}

copyFileSync(SAMPLE, TARGET);
console.log("wrote llm.json from llm.json.example — the 'scripted' profile is active.");
