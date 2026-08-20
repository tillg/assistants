/**
 * Generate the idempotent migration that switches the seven built-in `bookkeeping.*` Operations to
 * dynamic (ADR-0025), embedding each Operation's stored Source read from
 * `import/operations/bookkeeping/`. Run it whenever the shipped Source changes:
 *
 *     node scripts/generate-bookkeeping-migration.mjs
 *
 * It writes `import/migrations/2026-08-19-bookkeeping-operations-dynamic.sql`. The Source is embedded
 * so an already-installed stack — whose Operation Things carry no Source — switches over in one
 * offline UPDATE, rather than depending on bootstrap, which never re-applies a decision field.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(ROOT, "import/operations/bookkeeping");
const OUT = join(ROOT, "import/migrations/2026-08-19-bookkeeping-operations-dynamic.sql");

const PRELUDE = readFileSync(join(SRC_DIR, "prelude.ts"), "utf8");
const source = (op) => PRELUDE + "\n" + readFileSync(join(SRC_DIR, `${op}.ts`), "utf8");

const OPERATIONS = [
    { key: "bookkeeping.getBalance", op: "getBalance", mutating: false, clientReadable: false },
    { key: "bookkeeping.listAccounts", op: "listAccounts", mutating: false, clientReadable: true },
    { key: "bookkeeping.listOpenItems", op: "listOpenItems", mutating: false, clientReadable: false },
    { key: "bookkeeping.listTransactions", op: "listTransactions", mutating: false, clientReadable: true },
    { key: "bookkeeping.getBudgetReport", op: "getBudgetReport", mutating: false, clientReadable: false },
    { key: "bookkeeping.createAccount", op: "createAccount", mutating: true, clientReadable: false },
    { key: "bookkeeping.postTransaction", op: "postTransaction", mutating: true, clientReadable: false },
];

const KEYS = OPERATIONS.map((o) => `'${o.key}'`).join(", ");

// A dollar-quote tag that cannot appear in the Source. TypeScript source never contains `$sql...$`.
function dollarQuote(text, index) {
    let tag = `$src${index}$`;
    // Progressive escalation so the loop always terminates, even in the pathological case where the
    // source contains the tag itself (impossible for real TypeScript, but the loop must still be sound).
    for (let n = 0; text.includes(tag); n++) tag = `$src${index}x${n}$`;
    return `${tag}${text}${tag}`;
}

function caseExpr(field, mapper, fallback) {
    const arms = OPERATIONS.map((o) => `            WHEN '${o.key}' THEN ${mapper(o)}`).join("\n");
    return `        '${field}', (\n            CASE d.content::jsonb #>> '{Operation,Key}'\n${arms}\n            ELSE ${fallback}\n            END\n        )`;
}

const sourceCase = caseExpr(
    "Source",
    (o) => dollarQuote(source(o.op), OPERATIONS.indexOf(o)),
    `(d.content::jsonb #>> '{Operation,Source}')`,
);
const mutatingCase = caseExpr("Mutating", (o) => (o.mutating ? "true" : "false"), "false");
const clientReadableCase = caseExpr("ClientReadable", (o) => (o.clientReadable ? "true" : "false"), "false");

const header = `-- Switch the seven built-in bookkeeping Operations to dynamic (ADR-0025).
--
-- Each Operation's Source, egress and language are written onto its Operation Thing, and the two
-- flags the registry and the inbound gate now read OFF the Thing for a dynamic Operation — Mutating
-- and ClientReadable — are set here too, because the values these Things carried from their built-in
-- days were never authoritative and cannot be trusted. ClientReadable is set true only on
-- listAccounts and listTransactions (the two the Dashboard reads); Mutating true only on
-- postTransaction and createAccount.
--
-- Idempotent: the WHERE clause matches only Things not yet switched (Implementation is not already
-- 'dynamic'), so a second run is a no-op. Atomic: one UPDATE, so a failure at row 5 of 7 rolls the
-- whole statement back — there is no half-migrated state to clean up; re-run it.
--
-- ORDER — run it OFFLINE, in the same maintenance window as the image swap, never against a live old
-- Runtime. Either interleaving observed by a running Runtime strands the seven Operations: a migrated
-- Thing (Implementation: dynamic) meeting the still-compiled code drops as 'ambiguous', and the new
-- image meeting an un-migrated Thing drops as 'unimplemented'. With the Runtime down for the swap,
-- neither window is ever live.
--
--     docker exec -i <PROJECT>_postgres psql -U <DATASERVICES_USERNAME> -d <DATASERVICES_DB> \\
--         < import/migrations/2026-08-19-bookkeeping-operations-dynamic.sql
--
-- RE-INDEX — this writes the document rows directly, which the A12 server does not observe until it
-- re-indexes at startup. Restart (or recreate) the SERVER after applying the migration so its query
-- index picks up the new Implementation/Source/Egress — otherwise the Operations overview and form
-- show the pre-migration (blank) values, even though the runtime reads the migrated rows fresh.
-- Verified 2026-08-20: the server re-indexed the migrated dynamic documents with no restart loop.
--
-- REVERSIBILITY — rollback is NOT code-only. Restoring the previous image (compiled bookkeeping.*
-- back) while the Things still read Implementation: dynamic drops all seven as 'ambiguous'. To roll
-- back, restore the old image AND revert the Thing fields in the same offline window — the
-- down-migration below does that (Implementation to built-in, Source cleared). It is commented out;
-- uncomment and run it, then bring the old image up.
--
-- GENERATED by scripts/generate-bookkeeping-migration.mjs from import/operations/bookkeeping/ — the
-- embedded Source matches the seed byte for byte, so bootstrap reports no divergence. Regenerate it
-- rather than editing it by hand.
`;

const up = `${header}
UPDATE document AS d
SET content = (
    d.content::jsonb
    || jsonb_build_object(
        'Operation',
        (d.content::jsonb -> 'Operation')
        || jsonb_build_object(
            'Implementation', 'dynamic',
            'Language', 'typescript',
            'Egress', 'bookkeeping',
${mutatingCase},
${clientReadableCase},
${sourceCase}
        )
    )
)::text
WHERE d.model_name = 'Operation_DM'
  AND d.content::jsonb #>> '{Operation,Key}' IN (${KEYS})
  AND (d.content::jsonb #>> '{Operation,Implementation}') IS DISTINCT FROM 'dynamic';
`;

const down = `
-- DOWN-MIGRATION (commented out). Run it in the same offline window as restoring the old image.
--
-- UPDATE document AS d
-- SET content = (
--     d.content::jsonb
--     || jsonb_build_object(
--         'Operation',
--         ((d.content::jsonb -> 'Operation') - 'Source' - 'Language' - 'Egress')
--         || jsonb_build_object('Implementation', 'built-in')
--     )
-- )::text
-- WHERE d.model_name = 'Operation_DM'
--   AND d.content::jsonb #>> '{Operation,Key}' IN (${KEYS})
--   AND (d.content::jsonb #>> '{Operation,Implementation}') = 'dynamic';
`;

writeFileSync(OUT, up + down);
console.log(`Wrote ${OUT} (${(up + down).length} bytes, ${OPERATIONS.length} operations).`);
