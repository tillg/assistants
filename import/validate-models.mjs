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

const ROOT = new URL("./models/", import.meta.url).pathname;

/** Machine-owned fields that are deliberately absent from every form. */
const INTENTIONALLY_UNEXPOSED = new Set([
    // The four machine fields. `createdAt` is shown where a human benefits (the Conversation
    // header); elsewhere it is noise.
    "f_idempotencyKey",
    "f_createdByConversationId",
    "f_updatedAt",
    "f_createdAt",
    // Runtime bookkeeping the User has no use for.
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
    RuntimeState_DM: ["f_singletonKey", "f_heartbeatAt"],
    Document_DM: ["f_createdAt", "f_idempotencyKey", "f_createdByConversationId"],
    Invoice_DM: ["f_createdAt", "f_idempotencyKey", "f_createdByConversationId", "f_invoiceNumber"],
    Party_DM: ["f_createdAt", "f_idempotencyKey"],
    Process_DM: ["f_createdAt", "f_idempotencyKey"],
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
            });
        }
        if (node.type === "Group" && node.id) {
            fields.set(node.id, { name: node.name, group: true, indexed: false, isMarkdown: false });
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

    if (isForm) {
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
