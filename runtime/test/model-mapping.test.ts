/**
 * The Runtime's field-name map must agree with the A12 models on disk.
 *
 * This exists because it already went wrong once: the models named an Assistant's tool field
 * `ToolOperation` while the Runtime wrote `Operation`, and the only symptom was
 * `ADD_DOCUMENT failed ... rollback was performed` from a live server. Nothing in TypeScript can
 * catch that — the map is strings on one side and JSON on the other — so it is checked here.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SPECS, fromDocument, toDocument, type ModelSpec } from "../src/a12/things.js";
import type { Operation } from "../src/domain/types.js";

const MODELS_DIR = fileURLToPath(new URL("../../import/models/", import.meta.url));

interface GroupShape {
    name: string;
    fields: Set<string>;
    groups: Map<string, GroupShape>;
}

function readModel(id: string): Record<string, unknown> {
    const found = collect(MODELS_DIR).find((file) => file.endsWith(`${id}.json`));
    if (!found) throw new Error(`No model file for ${id}`);
    return JSON.parse(readFileSync(found, "utf8")) as Record<string, unknown>;
}

function collect(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...collect(full));
        else if (entry.endsWith(".json")) out.push(full);
    }
    return out;
}

/** The document shape a model actually declares: root group, its fields, and its sub-groups. */
function shapeOf(model: Record<string, unknown>): GroupShape {
    const content = model["content"] as Record<string, unknown>;
    const modelRoot = content["modelRoot"] as Record<string, unknown>;
    const roots = modelRoot["rootGroups"] as Array<Record<string, unknown>>;
    const root = roots[0]!;
    return groupShape(root);
}

function groupShape(node: Record<string, unknown>): GroupShape {
    const payload = (node["Group"] ?? {}) as Record<string, unknown>;
    const elements = (payload["elements"] ?? []) as Array<Record<string, unknown>>;
    const fields = new Set<string>();
    const groups = new Map<string, GroupShape>();
    for (const element of elements) {
        if (element["type"] === "Field") fields.add(String(element["name"]));
        else if (element["type"] === "Group") {
            const child = groupShape(element);
            groups.set(child.name, child);
        }
    }
    return { name: String(node["name"]), fields, groups };
}

describe("the Runtime's model map matches the models on disk", () => {
    for (const [id, spec] of Object.entries(SPECS) as Array<[string, ModelSpec]>) {
        describe(id, () => {
            const shape = shapeOf(readModel(id));

            it("agrees on the root group name", () => {
                expect(shape.name).toBe(spec.root);
            });

            it("only maps scalar fields that exist", () => {
                const missing = Object.entries(spec.fields)
                    .filter(([, field]) => !shape.fields.has(field))
                    .map(([property, field]) => `${property} -> ${field}`);
                expect(missing).toEqual([]);
            });

            it("only maps groups and group fields that exist", () => {
                const problems: string[] = [];
                for (const [property, group] of Object.entries(spec.groups ?? {})) {
                    const declared = shape.groups.get(group.name);
                    if (!declared) {
                        problems.push(`group ${property} -> ${group.name} does not exist`);
                        continue;
                    }
                    for (const [inner, field] of Object.entries(group.fields)) {
                        if (!declared.fields.has(field)) {
                            problems.push(`${group.name}.${inner} -> ${field} does not exist`);
                        }
                    }
                }
                expect(problems).toEqual([]);
            });
        });
    }
});

/**
 * An Operation carries two fields no other Model does: a JSON Schema and a markdown description,
 * both of which contain the characters a naive mapping would mangle. The round trip is what says
 * the catalogue can be written and read back as it was written.
 */
describe("an Operation survives the round trip", () => {
    it("preserves every field, including Parameters with newlines and braces", () => {
        const operation: Required<Operation> = {
            key: "bookkeeping.postTransaction",
            name: "Book a transaction",
            system: "Bookkeeping",
            kind: "connector",
            description: "Book a balanced transaction.\n\nAccount names **must** already exist.",
            mutating: true,
            requiresApproval: true,
            enabled: false,
            notes: "Switched off while the books are being reconciled.",
            parameters: '{\n  "type": "object",\n  "properties": { "splits": { "type": "array" } }\n}',
            idempotencyKey: "operation:bookkeeping.postTransaction",
            createdByConversationId: "",
            createdAt: "2026-08-13T10:00:00",
            updatedAt: "2026-08-13T10:00:00",
        };

        const document = toDocument(SPECS.Operation_DM, operation);
        expect(fromDocument(SPECS.Operation_DM, document)).toEqual(operation);
    });
});
