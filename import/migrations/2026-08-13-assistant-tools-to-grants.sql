-- Rename the stored Assistant group `Tools` to `Grants`, and its field `ToolOperation` to
-- `OperationKey`.
--
-- Why this file exists, when the change that needed it said it would not:
--
-- `specs/changes/operations-as-things/architecture.md` predicted that stored Assistant documents
-- would simply "read as grant-less until bootstrap re-seeds them" — a recoverable state, costing
-- nothing in this repo because every grant list comes from an `AssistantSeed`. That is wrong, and
-- the way it is wrong is worth knowing: A12 does not ignore a group it cannot find. It **fails the
-- document's validation**, and that failure happens during the query re-index the server runs at
-- startup:
--
--     Batch indexing failed (rolled back the batch, interrupting). model=Assistant_DM
--     The validation of document with document reference 'Assistant_DM/75db…' failed.
--     For the entity instance 'Assistant/Tools', the corresponding entity was not found in
--     the corresponding document model.
--
-- The batch failure aborts startup, so the server never comes up — 34 restart loops before this was
-- diagnosed. The blast radius is the whole stack, not one Assistant's grants.
--
-- Renaming in place rather than deleting the documents: it keeps `__meta.creator` and
-- `__meta.createdAt`, and it is the migration a repo with hand-edited Assistants would actually
-- need. Deleting and re-bootstrapping happens to be lossless *here* only because there are no
-- hand-edited Assistants.
--
-- Idempotent: the `WHERE` clause matches only documents that still carry the old group, so running
-- it twice is a no-op. Run it **after** the new model is imported and **before** the server is
-- expected to come up — or, if the server is already crash-looping, run it and restart the server.
--
--     docker exec assistants_postgres psql -U <DATASERVICES_USERNAME> -d <DATASERVICES_DB> \
--         -f /dev/stdin < import/migrations/2026-08-13-assistant-tools-to-grants.sql

UPDATE document AS d
SET content = (
    d.content::jsonb
    || jsonb_build_object(
        'Assistant',
        ((d.content::jsonb -> 'Assistant') - 'Tools')
        || jsonb_build_object(
            'Grants',
            COALESCE(
                (
                    SELECT jsonb_agg(jsonb_build_object('OperationKey', row ->> 'ToolOperation'))
                    FROM jsonb_array_elements(d.content::jsonb #> '{Assistant,Tools}') AS row
                ),
                '[]'::jsonb
            )
        )
    )
)::text
WHERE d.model_name = 'Assistant_DM'
  AND d.content::jsonb #> '{Assistant,Tools}' IS NOT NULL;
