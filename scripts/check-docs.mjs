#!/usr/bin/env node
/**
 * The documentation claims that can be checked mechanically.
 *
 * Most documentation cannot be tested and should not pretend to be. These four can, and each of them
 * had gone stale in a way a reader could not detect: a repository tree that counted ten ADRs when
 * there were fifteen, a test table missing the one tier that needs the stack up, `just --list`
 * printing the tail of a wrapped sentence as a recipe's summary, and a "follow these steps" recipe
 * that produced a model the validator rejects.
 *
 * The justfile's own header says "every recipe here is documented in README.md", and CONVENTIONS.md
 * states the blank-line rule that keeps `just --list` readable. Both are checked here rather than
 * hoped for.
 *
 * Run: node scripts/check-docs.mjs
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const failures = [];

const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const justfile = readFileSync(join(ROOT, "justfile"), "utf8");
const conventions = readFileSync(join(ROOT, "import/models/CONVENTIONS.md"), "utf8");

// ---------------------------------------------------------------- the ADR count

const NUMBER_WORDS = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
    "nineteen", "twenty", "twenty-one", "twenty-two", "twenty-three", "twenty-four", "twenty-five",
    "twenty-six", "twenty-seven", "twenty-eight", "twenty-nine", "thirty",
];

const adrCount = readdirSync(join(ROOT, "docs/adr")).filter((name) => /^\d{4}-.*\.md$/.test(name)).length;
const expectedWord = NUMBER_WORDS[adrCount];

if (expectedWord === undefined) {
    // Past the table: comparing every number word against `undefined` would report spurious failures
    // ending "(undefined)" and no count could ever validate. Say the actionable thing instead.
    failures.push(
        `check-docs: docs/adr/ holds ${adrCount} ADRs, past the NUMBER_WORDS table ` +
            `(max ${NUMBER_WORDS.length - 1}). Extend NUMBER_WORDS in scripts/check-docs.mjs.`,
    );
} else {
    for (const [index, line] of readme.split("\n").entries()) {
        const match = /\b([a-z]+(?:-[a-z]+)?)\s+architecture decision/.exec(line);
        if (!match) continue;
        const said = match[1];
        if (!NUMBER_WORDS.includes(said)) continue;
        if (said !== expectedWord) {
            failures.push(
                `README.md:${index + 1} says "${said} architecture decision…" but docs/adr/ holds ` +
                    `${adrCount} (${expectedWord}). Both places that count them must agree with the directory.`,
            );
        }
    }
}

// ---------------------------------------------------------------- every recipe is documented

/**
 * Recipe names, in order, with the line each is declared on.
 *
 * `:=` is an assignment, not a recipe — `compose := "docker compose …"` is not something `just`
 * lists or a reader invokes.
 */
function recipesOf(text) {
    const found = [];
    for (const [index, line] of text.split("\n").entries()) {
        const match = /^([a-z][a-z0-9-]*)((?:\s+[a-z_]+="[^"]*")*)\s*:(?!=)/.exec(line);
        if (match) found.push({ name: match[1], line: index + 1 });
    }
    return found;
}

const recipes = recipesOf(justfile);
if (recipes.length === 0) failures.push("justfile: no recipes found — this checker's parser has broken");

for (const recipe of recipes) {
    if (recipe.name === "default") continue; // `just` with no arguments; nothing to document
    // `just logs` is documented as `just logs runtime`, so the name may be followed by an argument
    // rather than by the closing backtick.
    const mentioned = new RegExp(`\`just ${recipe.name}[\` ]`).test(readme);
    if (!mentioned) {
        failures.push(
            `justfile:${recipe.line} declares "${recipe.name}" and README.md never mentions ` +
                `\`just ${recipe.name}\`. The justfile's own header says every recipe is documented there.`,
        );
    }
}

// ---------------------------------------------------------------- `just --list` stays readable

// `just --list` prints only the LAST comment line before a recipe. A block of several lines therefore
// shows up as the tail of a wrapped sentence — "only reset that is symmetric across both
// Authorities …", with no hint that the recipe destroys the books. The justfile documents the fix
// (a blank line before the one-line summary) and did not follow it in seven places.
const lines = justfile.split("\n");
for (const recipe of recipes) {
    const block = [];
    for (let at = recipe.line - 2; at >= 0; at -= 1) {
        const line = lines[at];
        if (!line.startsWith("#")) break;
        block.unshift(line);
    }
    if (block.length <= 1) continue;
    failures.push(
        `justfile:${recipe.line}: "${recipe.name}" has ${block.length} comment lines directly above ` +
            `it, and \`just --list\` shows only the last one — so its summary reads as a sentence ` +
            `fragment. Put the explanation above a blank line and leave one self-contained summary.`,
    );
}

// ---------------------------------------------------------------- the roles annotation

// Following README "Adding a Thing" and CONVENTIONS.md verbatim produced `"value": "user"`, which the
// validator rejects: the Runtime could not read the model. All 26 shipped models use "user,runtime".
for (const [name, text] of [["README.md", readme], ["import/models/CONVENTIONS.md", conventions]]) {
    for (const [index, line] of text.split("\n").entries()) {
        if (!/"roles"/.test(line)) continue;
        const value = /"value"\s*:\s*"([^"]*)"/.exec(line);
        if (!value) continue;
        if (!value[1].split(",").includes("runtime")) {
            failures.push(
                `${name}:${index + 1} prescribes roles "${value[1]}", which omits "runtime" — ` +
                    `\`just test-models\` rejects that, so the documented recipe cannot be followed.`,
            );
        }
    }
}

// ---------------------------------------------------------------- report

for (const failure of failures) console.error(`ERROR ${failure}`);
console.log(
    `\n${recipes.length} recipes and ${adrCount} ADRs checked against the docs — ${failures.length} problem(s)`,
);
process.exit(failures.length > 0 ? 1 : 0);
