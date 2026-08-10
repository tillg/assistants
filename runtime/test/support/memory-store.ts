/**
 * An in-memory ThingStore that implements the same surface as `A12Client`.
 *
 * This is a **fake, not a mock**: it really stores documents, really applies the constraint
 * operators the watcher uses, and really returns what it was given. Nothing is stubbed to make an
 * assertion pass. It exists because the behaviour worth testing here — suspend, resume, recover a
 * lease without re-executing — is *branching in the loop*, and exercising that against a Postgres
 * -backed Spring Boot service would make the suite slow enough that nobody would run it.
 *
 * The same scenarios run against the real Data Service in the integration tier, which is what
 * proves this fake tells the truth.
 */

import type { A12Document, Constraint, DocumentSpec, QueryResult, QuerySpec } from "../../src/a12/client.js";

interface Row {
    docRef: string;
    documentModelName: string;
    document: A12Document;
}

let counter = 0;

export class MemoryStore {
    readonly rows = new Map<string, Row>();
    /** Every write, in order — used to assert that recovery did not re-execute anything. */
    readonly writes: Array<{ method: string; docRef: string }> = [];
    /**
     * Make the next `ADD_DOCUMENT` fail, exactly as the real store does.
     *
     * The store rejects a document for a dozen structurally different reasons and the reason is
     * never in `error.message` — it sits in `error.data.description.default`. Reproducing a
     * rejection therefore needs the real error *object*, not a bare `throw new Error`, or the test
     * would be about a shape the store never produces.
     */
    failNextAdd: Error | undefined;

    async login(): Promise<void> {}

    async isReachable(): Promise<boolean> {
        return true;
    }

    async addDocument(documentModelName: string, document: A12Document): Promise<string> {
        if (this.failNextAdd) {
            const failure = this.failNextAdd;
            this.failNextAdd = undefined;
            throw failure;
        }
        counter += 1;
        const docRef = `${documentModelName}/${documentModelName.toLowerCase()}-${counter}`;
        this.rows.set(docRef, { docRef, documentModelName, document: structuredClone(document) });
        this.writes.push({ method: "ADD_DOCUMENT", docRef });
        return docRef;
    }

    async getDocument(docRef: string): Promise<DocumentSpec> {
        const row = this.rows.get(docRef);
        if (!row) throw new Error(`No document ${docRef}`);
        return {
            docRef: row.docRef,
            documentModelName: row.documentModelName,
            document: structuredClone(row.document),
        };
    }

    async modifyDocument(docRef: string, document: A12Document): Promise<void> {
        const row = this.rows.get(docRef);
        if (!row) throw new Error(`No document ${docRef}`);
        row.document = structuredClone(document);
        this.writes.push({ method: "MODIFY_DOCUMENT", docRef });
    }

    async deleteDocument(docRef: string): Promise<void> {
        this.rows.delete(docRef);
        this.writes.push({ method: "DELETE_DOCUMENT", docRef });
    }

    async query(spec: QuerySpec): Promise<QueryResult> {
        const all = [...this.rows.values()].filter(
            (row) => row.documentModelName === spec.targetDocumentModel,
        );
        const matching = all.filter((row) => matches(row.document, spec.constraint));
        // `sort` and a real `pageNumber`, because the live store has both — measured, not assumed.
        // A fake that ignored them agreed with the watermark bug: it made "the first page" and
        // "the oldest hundred" look like the same thing, which they are not.
        const sorted = sortRows(matching, spec.sort);
        const pageSize = spec.paging?.pageSize ?? 100;
        const pageNumber = spec.paging?.pageNumber ?? 0;
        return {
            fullSize: matching.length,
            entries: sorted
                .slice(pageNumber * pageSize, (pageNumber + 1) * pageSize)
                .map((row) => ({
                    type: "ROOT",
                    docRef: row.docRef,
                    documentModelName: row.documentModelName,
                    document: structuredClone(row.document),
                })),
        };
    }
}

/**
 * Apply `QuerySpec.sort`. Note `direction` and `nullHandling` — the server's own field names, not
 * the obvious ones, and getting them wrong is rejected at query time rather than ignored.
 *
 * Unsorted stays insertion order, which is what the real store does *not* promise. That is
 * deliberate: a caller that needs an order has to ask for one.
 */
function sortRows(rows: Row[], sort: QuerySpec["sort"]): Row[] {
    if (!sort || sort.length === 0) return rows;
    return [...rows].sort((left, right) => {
        for (const term of sort) {
            const a = valueAt(left.document, term.field);
            const b = valueAt(right.document, term.field);
            const aMissing = a === undefined || a === null || a === "";
            const bMissing = b === undefined || b === null || b === "";
            if (aMissing || bMissing) {
                if (aMissing && bMissing) continue;
                return (aMissing ? 1 : -1) * (term.nullHandling === "NULLS_FIRST" ? -1 : 1);
            }
            let compared = term.ignoreCase
                ? String(a).toLowerCase().localeCompare(String(b).toLowerCase())
                : String(a).localeCompare(String(b));
            if (term.direction === "DESC") compared = -compared;
            if (compared !== 0) return compared;
        }
        return 0;
    });
}

/** Resolve an A12 query path (`/Conversation/Status`) against a document. */
function valueAt(document: A12Document, path: string): unknown {
    const segments = path.split("/").filter(Boolean);
    let node: unknown = document;
    for (const segment of segments) {
        if (node === null || typeof node !== "object") return undefined;
        node = (node as Record<string, unknown>)[segment];
    }
    return node;
}

function matches(document: A12Document, constraint: Constraint | undefined): boolean {
    if (!constraint) return true;
    switch (constraint.operator) {
        case "and":
            return (constraint["operands"] as Constraint[]).every((operand) =>
                matches(document, operand),
            );
        case "or":
            return (constraint["operands"] as Constraint[]).some((operand) => matches(document, operand));
        case "not":
            // Singular `operand`, matching the real API.
            return !matches(document, constraint["operand"] as Constraint);
        case "exact_match": {
            const actual = valueAt(document, String(constraint["field"]));
            return actual !== undefined && String(actual) === String(constraint["value"]);
        }
        case "undefined_match": {
            const actual = valueAt(document, String(constraint["field"]));
            return actual === undefined || actual === null || actual === "";
        }
        case "date_range": {
            const actual = valueAt(document, String(constraint["field"]));
            if (typeof actual !== "string" || !actual) return false;
            const from = constraint["from"] as string | undefined;
            const to = constraint["to"] as string | undefined;
            if (from && actual < from) return false;
            if (to && actual > to) return false;
            return true;
        }
        default:
            throw new Error(`MemoryStore does not implement the "${constraint.operator}" operator`);
    }
}
