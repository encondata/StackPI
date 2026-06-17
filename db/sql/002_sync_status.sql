-- Sync-state tracker for synced-from-elsewhere data (asset lists, etc.).
-- One row per logical entity; NULL last_synced_at means "never synced".

BEGIN;

CREATE TABLE IF NOT EXISTS local_sync_status (
    entity TEXT PRIMARY KEY,
    last_synced_at TIMESTAMPTZ
);

-- Seed the rows the Overview page queries so they exist even before the
-- first sync. Idempotent — ON CONFLICT keeps any non-null value already set.
INSERT INTO local_sync_status (entity, last_synced_at) VALUES
    ('moves_asset_list', NULL)
ON CONFLICT (entity) DO NOTHING;

COMMIT;
