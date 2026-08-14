#!/usr/bin/env node
/**
 * Model validation, in both directions.
 *
 * `elementRef` → field is the easy direction and it fails the build. The other direction —
 * data-model fields that no form model references — is the one ADR-0008 admits is hard and
 * explicitly accepts as a gap ("a newly added data-model field that no form model references
 * stays invisible in the UI"). ADR-0008 promises a *hint* about it; this is that hint, which
 * makes it the cheapest possible test of the ADR itself.
 *
 * Run: node import/validate-models.mjs
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

/**
 * `MODELS_DIR` exists so the validator can be pointed at a mutated copy of the models — which is
 * how `validate-models.selftest.mjs` proves each check actually bites. A check nobody has ever seen
 * fail is a check you are trusting, not one you have tested; four of the rules CONVENTIONS.md calls
 * load-bearing turned out never to have been enforced at all.
 */
const ROOT = process.env["MODELS_DIR"]
    ? `${process.env["MODELS_DIR"].replace(/\/*$/, "")}/`
    : new URL("./models/", import.meta.url).pathname;

/** Machine-owned fields that are deliberately absent from every form. */
const INTENTIONALLY_UNEXPOSED = new Set([
    // The four machine fields. `createdAt` is shown where a human benefits (the Conversation
    // header); elsewhere it is noise.
    "f_idempotencyKey",
    "f_createdByConversationId",
    "f_updatedAt",
    "f_createdAt",
    // Runtime bookkeeping the User has no use for — except `f_maxTurns`, which the Conversation
    // Header does show, as the denominator of `turn 4/20`. It stays on this list because the list
    // is about **Controls**, and the Header is not one; but the sentence above stopped being true
    // of it the day the Header started reading it.
    "f_leaseUntil",
    "f_maxTurns",
    "f_escalationCount",
    "f_resultDeliveredAt",
    "f_wm_docRef",
    "f_entry_idempotencyKey",
    "f_seq",
    // The attachment group is driven as a whole by A12's attachment widget; its nine internal
    // fields are never placed individually on a form.
    "f_attachment_originalFilename",
    "f_attachment_internalFilename",
    "f_attachment_content",
    "f_attachment_attachmentId",
    "f_attachment_size",
    "f_attachment_mimeType",
    "f_attachment_thumbnail",
    "f_attachment_category",
    "f_attachment_description",
]);

/** Fields the Runtime filters on. Each must exist and carry the `indexed` annotation. */
const WATCHER_FIELDS = {
    Assistant_DM: ["f_key"],
    Conversation_DM: [
        "f_assistantKey",
        "f_subjectThingId",
        // Scan 7's entire exactly-once guarantee is one `exact_match` on this field. Unindexed, it
        // answers nothing — and "nothing" is indistinguishable from "this slot has not been served",
        // so a daily schedule would give birth on every scan until the hourly cap stopped it.
        "f_scheduledFor",
        "f_status",
        "f_waitingFor",
        "f_wakeAt",
        "f_leaseUntil",
        "f_parentConversationId",
        "f_currentQuestionId",
        "f_resultDeliveredAt",
        "f_createdAt",
    ],
    OpenQuestion_DM: ["f_conversationId", "f_answeredAt", "f_idempotencyKey"],
    // Bootstrap finds every Operation by this one field. Unindexed it answers nothing, which reads
    // as "not created yet" — so `just bootstrap` would create seventeen duplicates, every run.
    Operation_DM: ["f_idempotencyKey"],
    RuntimeState_DM: ["f_singletonKey", "f_heartbeatAt"],
    Document_DM: ["f_createdAt", "f_idempotencyKey", "f_createdByConversationId"],
    Invoice_DM: ["f_createdAt", "f_idempotencyKey", "f_createdByConversationId", "f_invoiceNumber"],
    Party_DM: ["f_createdAt", "f_idempotencyKey"],
    Process_DM: ["f_createdAt", "f_idempotencyKey"],
};

/**
 * The six keys `isFormModelContent()` requires of every form model's `content`.
 *
 * Taken from the form engine itself (`formengine-core`'s `FormModelGuards`): it tests `"key" in
 * value` for each, and `unmarshallFormModel` throws before touching anything else if one is absent.
 * An empty object is a perfectly good value — six of the eight forms ship `"subHeaderBox": {"id":
 * "subHeaderBox1"}` and render no extra chrome for it.
 */
const FORM_CONTENT_KEYS = [
    "subHeaderBox",
    "footerBox",
    "screens",
    "fieldConfiguration",
    "groupConfiguration",
    "defaults",
];

/**
 * Fields without which a Thing is not a Thing of that Model.
 *
 * `requirednessConfig` is the only requiredness carrier a Model has, and it binds *both* writers —
 * the User through the form and the Runtime through `thingstore.create`. An Operation-layer check
 * would leave the UI hole open, which is why this lives in the Model.
 *
 * Invoice is the entry that matters: it declared none at all, so `thingstore.create` with `{}` was
 * accepted, and an Invoice with no number, no issuer, no date and no amount appeared in the overview
 * and in every search result indistinguishable from a real one. It is also the one Model that feeds
 * a money decision. These four are exactly `Invoice_OM`'s identifying columns — the four without
 * which the overview row is blank.
 */
const MANDATORY_FIELDS = {
    Party_DM: ["f_name"],
    Process_DM: ["f_title"],
    Document_DM: ["f_title"],
    Invoice_DM: ["f_invoiceNumber", "f_issuerName", "f_issueDate", "f_amountGross"],
};

const errors = [];
const warnings = [];

function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        errors.push(`${basename(path)}: not valid JSON — ${error.message}`);
        return undefined;
    }
}

function collectFiles(dir) {
    const out = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...collectFiles(full));
        else if (entry.endsWith(".json")) out.push(full);
    }
    return out;
}

function walk(node, visit) {
    if (Array.isArray(node)) {
        for (const item of node) walk(item, visit);
    } else if (node && typeof node === "object") {
        visit(node);
        for (const value of Object.values(node)) walk(value, visit);
    }
}

const files = collectFiles(ROOT);
const models = new Map();

for (const file of files) {
    const model = readJson(file);
    if (!model) continue;
    const id = model.header?.id ?? basename(file, ".json");
    models.set(id, { file, model });
}

// ---------------------------------------------------------------- per-model checks

for (const [, { file, model }] of models) {
    const where = basename(file);
    const header = model.header ?? {};

    const roles = (header.annotations ?? []).find((a) => a.name === "roles");
    if (!roles) errors.push(`${where}: header is missing the mandatory "roles" annotation`);
    else if (!String(roles.value).split(",").includes("runtime")) {
        errors.push(`${where}: roles "${roles.value}" does not include "runtime" — the Runtime cannot read this model`);
    }

    const locales = (header.locales ?? []).map((l) => l.code);
    if (!locales.includes("en") || !locales.includes("de")) {
        errors.push(`${where}: header must declare both en and de locales`);
    }

    // The WCF converter writes `<header.id>.json`, so a mismatch ships the model under a name no
    // application model resolves. Never compared: line 108 uses the filename only as a *fallback*
    // when `header.id` is absent. Silent for FM/AM/QeM; for a _DM it surfaced as three misleading
    // errors about a model that "does not exist".
    const expectedId = basename(file, ".json");
    if (header.id !== undefined && header.id !== expectedId) {
        errors.push(
            `${where}: header.id is "${header.id}" but the filename says "${expectedId}" — the WCF ` +
                `converter writes <header.id>.json, so this would ship under a name nothing resolves`,
        );
    }

    // `header.labels` is the model's own title — the string the navigation shows. The bilingual check
    // below matches the singular key `label`, which headers do not use, so the one label a User is
    // guaranteed to read was checked in neither language. An error rather than a warning, because
    // its neighbour `header.locales` is already one.
    if (Array.isArray(header.labels)) {
        const codes = header.labels.map((label) => label.locale);
        if (!codes.includes("en") || !codes.includes("de")) {
            errors.push(
                `${where}: header.labels is not bilingual (${codes.join(",") || "empty"}) — this is ` +
                    `the model's own title, the string the navigation shows`,
            );
        }
    }

    // Labels must be bilingual wherever they appear as an array of {locale,text}.
    walk(model, (node) => {
        if (Array.isArray(node.label) && node.label.length > 0 && node.label[0]?.locale) {
            const codes = node.label.map((l) => l.locale);
            if (!codes.includes("en") || !codes.includes("de")) {
                warnings.push(`${where}: a label is not bilingual (${codes.join(",") || "empty"})`);
            }
        }
        // annotations must be a sibling of the payload key, never inside it
        for (const payload of ["Field", "Group"]) {
            if (node[payload] && typeof node[payload] === "object" && node[payload].annotations) {
                errors.push(`${where}: "annotations" is nested inside a "${payload}" payload (id ${node.id ?? "?"}) — it is silently ignored there`);
            }
        }
    });
}

// ---------------------------------------------------------------- DM field inventory

const dmFields = new Map(); // DM id -> Map(fieldId -> {name, indexed, isMarkdown, inGroup})

for (const [id, { model }] of models) {
    if (!id.endsWith("_DM")) continue;
    const fields = new Map();
    walk(model.content ?? {}, (node) => {
        if (node.type === "Field" && node.id) {
            const string = node.Field?.fieldType?.StringType;
            fields.set(node.id, {
                name: node.name,
                indexed: (node.annotations ?? []).some((a) => a.name === "indexed" && a.value === "true"),
                isMarkdown: Boolean(string?.lineBreaksPermitted),
                fieldType: node.Field?.fieldType?.type,
                required: Boolean(node.Field?.requirednessConfig),
            });
        }
        if (node.type === "Group" && node.id) {
            // The group's own fields, recorded because a `CustomScreenElement` annotated
            // `exposes: <groupId>` covers every one of them for the ADR-0008 check below. Without
            // this relation the rule could only mark the group itself, and the twelve Entry fields
            // under `f_entries` would still each warn.
            const children = new Set();
            walk(node.Group ?? {}, (inner) => {
                if (inner.type === "Field" && inner.id) children.add(inner.id);
            });
            fields.set(node.id, { name: node.name, group: true, children, indexed: false, isMarkdown: false });
        }
    });
    dmFields.set(id, fields);
}

// watcher fields exist and are indexed
for (const [dm, required] of Object.entries(WATCHER_FIELDS)) {
    const fields = dmFields.get(dm);
    if (!fields) {
        errors.push(`${dm}: missing entirely, but the watcher filters on it`);
        continue;
    }
    for (const fieldId of required) {
        const field = fields.get(fieldId);
        if (!field) errors.push(`${dm}: the watcher filters on ${fieldId}, which does not exist`);
        else if (!field.indexed) errors.push(`${dm}.${fieldId}: the watcher filters on it, so it must carry the "indexed" annotation`);
    }
}

for (const [dm, required] of Object.entries(MANDATORY_FIELDS)) {
    const fields = dmFields.get(dm);
    if (!fields) {
        errors.push(`${dm}: missing entirely, but fields of it are required`);
        continue;
    }
    for (const fieldId of required) {
        const field = fields.get(fieldId);
        if (!field) {
            errors.push(`${dm}: ${fieldId} is required but does not exist`);
        } else if (!field.required) {
            errors.push(
                `${dm}.${fieldId} (${field.name}) must carry "requirednessConfig" — without it the ` +
                    `Model accepts a Thing with this field empty, from the form and from ` +
                    `thingstore.create alike`,
            );
        }
    }
}

// An indexed field is one something filters on, so its type is load-bearing: A12 cannot filter an
// `EnumerationType` the way it filters a String, and CONVENTIONS.md prefaces these rules with "these
// are load-bearing. Breaking one produces a watcher that silently returns nothing". The validator
// already owned the list of filtered fields and checked the sibling rule (`indexed`) against it, and
// simply never inspected the type. Checked for *every* indexed field rather than only the ones
// WATCHER_FIELDS names, because `operations/implementations.ts` exposes field filters the watcher
// itself does not use.
for (const [dm, fields] of dmFields) {
    for (const [fieldId, field] of fields) {
        if (field.group || !field.indexed) continue;
        if (field.fieldType !== "StringType" && field.fieldType !== "DateTimeType") {
            errors.push(
                `${dm}.${fieldId} (${field.name}) is annotated "indexed" but is a ${field.fieldType ?? "unknown type"} — ` +
                    `only StringType and DateTimeType can be filtered on, so a query on it returns nothing`,
            );
        }
    }
}

// The four machine fields, last and in order. CONVENTIONS.md states it and nothing enforced it, so
// all three of "out of order", "one missing" and "missing on Party/Process specifically" passed
// clean. The third matters most: `watcher.ts` reads `createdByConversationId` off every
// trigger-eligible Thing for the guard that stops the Runtime feeding on its own output, and the
// presence check covered only two of the four trigger-eligible Models.
const MACHINE_FIELD_TAIL = [
    "f_idempotencyKey",
    "f_createdByConversationId",
    "f_createdAt",
    "f_updatedAt",
];

for (const [id, { file, model }] of models) {
    if (!id.endsWith("_DM")) continue;
    const where = basename(file);
    const rootGroups = model.content?.modelRoot?.rootGroups ?? [];
    if (rootGroups.length !== 1) {
        errors.push(`${where}: expected exactly one root group, found ${rootGroups.length}`);
        continue;
    }
    const elements = rootGroups[0]?.Group?.elements ?? [];
    const tail = elements.slice(-MACHINE_FIELD_TAIL.length).map((element) => element.id);
    if (tail.join(",") !== MACHINE_FIELD_TAIL.join(",")) {
        errors.push(
            `${where}: the root group must end with the four machine fields in order ` +
                `(${MACHINE_FIELD_TAIL.join(",")}) — found ${tail.join(",") || "(nothing)"}`,
        );
    }
}

// ---------------------------------------------------------------- FM / OM cross-checks

for (const [id, { file, model }] of models) {
    const where = basename(file);
    const isForm = id.endsWith("_FM");
    const isOverview = id.endsWith("_OM");
    if (!isForm && !isOverview) continue;

    const purpose = isForm ? "data binding" : "document-model-for-overview";
    const reference = (model.header?.modelReferences ?? []).find((r) => r.purpose === purpose);
    if (!reference) {
        errors.push(`${where}: no modelReference with purpose "${purpose}"`);
        continue;
    }
    const dm = reference.reference;
    const fields = dmFields.get(dm);
    if (!fields) {
        errors.push(`${where}: references ${dm}, which does not exist`);
        continue;
    }

    const referenced = new Set();
    walk(model.content ?? {}, (node) => {
        for (const key of ["elementRef", "groupRef"]) {
            if (typeof node[key] === "string") {
                referenced.add(node[key]);
                if (!fields.has(node[key])) {
                    errors.push(`${where}: ${key} "${node[key]}" does not exist in ${dm}`);
                }
            }
        }
    });

    if (isOverview) {
        // The overview engine reads `content.rowActionGroup.actions` without guarding it, so an
        // absent key is not "no row actions" — it is a TypeError and a table that never renders.
        // An empty `actions` array is how you say "no row actions". Learned by breaking three
        // modules at once.
        const group = model.content?.rowActionGroup;
        if (!group || !Array.isArray(group.actions)) {
            errors.push(`${where}: every overview model needs "rowActionGroup": {"actions": [...]}, even when empty — the overview engine dereferences .actions unguarded and the table will not render`);
        }
    }

    if (isForm) {
        // The form engine gates every form model on `isFormModelContent()`, which is a plain
        // `"key" in content` check over these six. A missing key is not a default: `unmarshallFormModel`
        // throws "Json is no valid FormModel!" as its first statement, the client reports only
        // `Post processing for model "X" failed.` — swallowing the real cause into a `source` field
        // nothing logs — and the form never renders at all. Two forms shipped that way, for days,
        // and neither the model checker nor the converter nor this validator noticed.
        for (const key of FORM_CONTENT_KEYS) {
            if (!(key in (model.content ?? {}))) {
                errors.push(
                    `${where}: content is missing the mandatory key "${key}" — the form engine's ` +
                        `isFormModelContent() gate rejects the whole model, so the form will not open ` +
                        `at all ("Post processing for model failed")`,
                );
            }
        }

        const configured = (model.content?.fieldConfiguration?.field ?? []).map((f) => f.elementRef);
        const seen = new Set();
        for (const ref of configured) {
            if (seen.has(ref)) {
                errors.push(`${where}: elementRef "${ref}" appears more than once in fieldConfiguration.field[] — this causes a runtime "Post processing for model failed" the model checker does not catch`);
            }
            seen.add(ref);
        }

        // The markdown triple: lineBreaksPermitted + exposition AREA + the widget annotation.
        const areaRefs = new Set(
            (model.content?.fieldConfiguration?.field ?? [])
                .filter((f) => f.exposition === "AREA")
                .map((f) => f.elementRef),
        );
        const annotated = new Set();
        walk(model.content ?? {}, (node) => {
            if ((node.annotations ?? []).some((a) => a.name === "widget" && a.value === "markdown-editor")) {
                if (node.elementRef) annotated.add(node.elementRef);
            }
        });
        for (const ref of annotated) {
            if (!areaRefs.has(ref)) {
                errors.push(`${where}: ${ref} has the markdown-editor widget annotation but no "exposition": "AREA" — it will render as a single-line input`);
            }
            if (!fields.get(ref)?.isMarkdown) {
                errors.push(`${where}: ${ref} has the markdown-editor widget annotation but ${dm} does not set lineBreaksPermitted — the kernel will reject newlines`);
            }
        }

        // A `CustomScreenElement` renders a group with custom code rather than an `InlineRepeat`,
        // so the group's fields are on the screen without any `elementRef` naming them. `exposes`
        // is how the form says which group that is, and it has exactly two readers: this check,
        // and a human reading the model file.
        //
        // The annotation is OPTIONAL. An element that renders *another document's* data carries
        // `widget` alone — `OpenQuestion_FM`'s transcript shows a Conversation's Entries, and
        // `OpenQuestion_DM` has no such group — so silence here is legal and means "this element
        // makes no coverage claim". What is not legal is naming a group that does not exist: a
        // typo would otherwise silently cover nothing, which is worse than the warning it replaced.
        walk(model.content ?? {}, (node) => {
            if (node.type !== "CustomScreenElement") return;
            const exposes = (node.annotations ?? []).find((a) => a.name === "exposes")?.value;
            if (!exposes) return;
            const group = fields.get(exposes);
            if (!group?.group) {
                errors.push(
                    `${where}: CustomScreenElement "${node.id}" is annotated exposes "${exposes}", ` +
                        `which is not a group of ${dm} — the coverage claim is false`,
                );
                return;
            }
            referenced.add(exposes);
            for (const child of group.children ?? []) referenced.add(child);
        });

        // ADR-0008, the hard direction: DM fields no form model references.
        for (const [fieldId, field] of fields) {
            if (field.group) continue;
            if (INTENTIONALLY_UNEXPOSED.has(fieldId)) continue;
            if (!referenced.has(fieldId)) {
                warnings.push(`${dm}.${fieldId} (${field.name}) is not referenced by ${id} — it will be invisible in the UI (ADR-0008)`);
            }
        }
    }
}

// ---------------------------------------------------------------- report

for (const warning of warnings) console.warn(`WARN  ${warning}`);
for (const error of errors) console.error(`ERROR ${error}`);

console.log(
    `\n${models.size} models checked — ${errors.length} error(s), ${warnings.length} warning(s)`,
);
process.exit(errors.length > 0 ? 1 : 0);
