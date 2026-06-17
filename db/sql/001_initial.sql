-- StackPI initial schema (file 001).
--
-- Convention: every file in db/sql/ is applied in lexical order by the
-- bootstrap script (after initdb + user/db create + any snapshot restore).
-- Each statement MUST be idempotent (IF NOT EXISTS, etc.) so re-runs are
-- safe on every boot.
--
-- For complex schema changes (rename, type change, etc.) we will graduate
-- to Alembic — but for create-only steps a plain .sql file is sufficient.

BEGIN;

CREATE TABLE IF NOT EXISTS local_rfid_raw_scans (
    id BIGSERIAL PRIMARY KEY
);

-- local_rfid_processed_scans is defined in 015_rfid_processed_scans.sql
-- (placeholder removed so a fresh install doesn't create an empty table
-- the real migration then has to drop).

CREATE TABLE IF NOT EXISTS local_moves_asset_list (
    id BIGSERIAL PRIMARY KEY
);

COMMIT;
