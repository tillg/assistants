#!/usr/bin/env node
/**
 * Does the validator actually bite?
 *
 * `validate-models.mjs` is the only mechanical guard on the rules CONVENTIONS.md calls load-bearing
 * — "breaking one produces a watcher that silently returns nothing" — and a guard that has never
 * been seen to fail is one you are trusting rather than one you have tested. Four of those rules
 * turned out never to have been enforced: an `EnumerationType` on a Runtime-filtered field, the four
 * machine fields and their order, a header label missing its German, and `header.id` matching the
 * filename. All four passed clean, exit 0, not even a warning.
 *
 * Each case below breaks exactly one rule in a *copy* of `import/models/`, runs the real validator
 * against it, and requires a matching error. The last case is the control: the shipped models must
 * still pass, so a check cannot be made to bite by making it fire on everything.
 *
 * Run: node import/validate-models.selftest.mjs
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HERE = new URL(".", import.meta.url).pathname;
const MODELS = join(HERE, "models");
const VALIDATOR = join(HERE, "validate-models.mjs");

/** Read, mutate, write one model inside the scratch copy. */
function edit(dir, relativePath, mutate) {
    const file = join(dir, relativePath);
    const model = JSON.parse(readFileSync(file, "utf8"));
    mutate(model);
    writeFileSync(file, JSON.stringify(model, null, 2));
}

/** The elements of a data model's single root group. */
function rootElements(model) {
    return model.content.modelRoot.rootGroups[0].Group.elements;
}

function fieldById(model, id) {
    const found = rootElements(model).find((element) => element.id === id);
    if (!found) throw new Error(`no field ${id} — the fixture has moved`);
    return found;
}

const CASES = [
    {
        name: "an EnumerationType on a Runtime-filtered field",
        why: "CONVENTIONS.md lists this first among the four query rules; f_status is filtered by four of the six scans",
        expect: /EnumerationType|must be a String or DateTime|indexed/i,
        break: (dir) =>
            edit(dir, "conversation/Conversation_DM.json", (model) => {
                const field = fieldById(model, "f_status");
                field.Field.fieldType = { type: "EnumerationType", EnumerationType: { enumerationId: "e_status" } };
            }),
    },
    {
        name: "the four machine fields out of order",
        why: "CONVENTIONS.md states the order; nothing checked it",
        expect: /machine fields/i,
        break: (dir) =>
            edit(dir, "party/Party_DM.json", (model) => {
                const elements = rootElements(model);
                const last = elements.splice(-4, 4);
                elements.push(last[2], last[0], last[1], last[3]);
            }),
    },
    {
        name: "createdByConversationId deleted from a trigger-eligible Model",
        why: "the watcher reads it off every trigger-eligible Thing for the runaway guard, and only two of the four were checked",
        expect: /machine fields|createdByConversationId/i,
        break: (dir) =>
            edit(dir, "process/Process_DM.json", (model) => {
                const elements = rootElements(model);
                const at = elements.findIndex((element) => element.id === "f_createdByConversationId");
                elements.splice(at, 1);
            }),
    },
    {
        name: "a header label missing its German",
        why: "the model's own title, the string the navigation shows, was never checked in either language",
        expect: /labels|bilingual/i,
        break: (dir) =>
            edit(dir, "invoice/Invoice_DM.json", (model) => {
                model.header.labels = model.header.labels.filter((label) => label.locale !== "de");
            }),
    },
    {
        name: "header.id not matching the filename",
        why: "the WCF converter writes <header.id>.json, so a mismatch ships under a name no application model resolves",
        expect: /filename|header\.id/i,
        break: (dir) =>
            edit(dir, "invoice/Invoice_FM.json", (model) => {
                model.header.id = "Invoice_Form";
            }),
    },
    {
        name: "a form model missing content.subHeaderBox",
        why: "BUG-15: the form engine's own gate rejects the model and the form never opens",
        expect: /subHeaderBox/,
        break: (dir) =>
            edit(dir, "invoice/Invoice_FM.json", (model) => {
                delete model.content.subHeaderBox;
            }),
    },
    {
        name: "an overview model without rowActionGroup.actions",
        why: "D-019: the overview engine dereferences .actions unguarded and the table does not render",
        expect: /rowActionGroup/,
        break: (dir) =>
            edit(dir, "invoice/Invoice_OM.json", (model) => {
                delete model.content.rowActionGroup;
            }),
    },
    {
        name: "roles without runtime, exactly as the docs used to prescribe",
        why: "BUG-29: the documented recipe could not reach its own step 9",
        expect: /roles/,
        break: (dir) =>
            edit(dir, "party/Party_DM.json", (model) => {
                const roles = model.header.annotations.find((annotation) => annotation.name === "roles");
                roles.value = "user";
            }),
    },
    {
        name: "a mandatory Invoice field losing its requirednessConfig",
        why: "BUG-24: Invoice is the one Model that feeds a money decision, and had no mandatory field at all",
        expect: /requirednessConfig|mandatory/i,
        break: (dir) =>
            edit(dir, "invoice/Invoice_DM.json", (model) => {
                delete fieldById(model, "f_amountGross").Field.requirednessConfig;
            }),
    },
];

function run(dir) {
    const result = spawnSync(process.execPath, [VALIDATOR], {
        env: { ...process.env, MODELS_DIR: dir },
        encoding: "utf8",
    });
    return { code: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function withCopy(action) {
    const dir = mkdtempSync(join(tmpdir(), "a12-models-"));
    try {
        cpSync(MODELS, dir, { recursive: true });
        return action(dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

let failures = 0;

// The control first: an unmutated copy must pass, or every case below proves nothing.
const control = withCopy((dir) => run(dir));
if (control.code !== 0) {
    failures += 1;
    console.error(`FAIL  control: the unmodified models do not pass\n${control.output}`);
} else {
    console.log("ok    control: the unmodified models pass");
}

for (const testCase of CASES) {
    const { code, output } = withCopy((dir) => {
        testCase.break(dir);
        return run(dir);
    });
    if (code === 0) {
        failures += 1;
        console.error(`FAIL  ${testCase.name}\n      the validator accepted it (exit 0). ${testCase.why}`);
    } else if (!testCase.expect.test(output)) {
        failures += 1;
        console.error(
            `FAIL  ${testCase.name}\n      rejected, but for the wrong reason — nothing matched ` +
                `${testCase.expect}\n${output}`,
        );
    } else {
        console.log(`ok    ${testCase.name}`);
    }
}

console.log(`\n${CASES.length + 1} validator checks exercised — ${failures} not enforced`);
process.exit(failures > 0 ? 1 : 0);
