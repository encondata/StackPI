-- Local cache of moves_assets_list filtered to ACTIVE moves only, with
-- the asset name/rfid_tag/make/model denormalized in from assets and
-- assets_make_model. Pulled by app/portal_sync.py from
-- GET /stackpi/sync/active-moves-assets.
--
-- Naming follows the cloud_sync_ prefix convention but doesn't include
-- the "active_" word since the active filter is implicit (the upstream
-- endpoint only emits active-move rows).

BEGIN;

CREATE TABLE IF NOT EXISTS cloud_sync_moves_assets (
    id                  BIGINT       PRIMARY KEY,   -- upstream moves_assets_list.id
    moves_id            BIGINT,                     -- which active move this asset belongs to
    asset_id            BIGINT,                     -- upstream assets.id (no FK)
    asset_serial_number TEXT,
    priority_wave       INTEGER,
    -- Denormalized from assets / assets_make_model
    asset_name          TEXT,
    asset_rfid_tag      TEXT,
    asset_make          TEXT,
    asset_model         TEXT,
    synced_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Look-up by moves_id is the primary access pattern (group assets by the
-- active move they belong to).
CREATE INDEX IF NOT EXISTS cloud_sync_moves_assets_moves_id_idx
    ON cloud_sync_moves_assets (moves_id);

-- Tag-resolution lookups: skip rows without an RFID tag.
CREATE INDEX IF NOT EXISTS cloud_sync_moves_assets_rfid_idx
    ON cloud_sync_moves_assets (asset_rfid_tag)
    WHERE asset_rfid_tag IS NOT NULL;

COMMIT;
