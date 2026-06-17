-- Local cache of ALL asset RFID tags from the portal (assets.rfid_tag),
-- pulled by app/portal_sync.py from GET /stackpi/sync/asset-tags. This is the
-- full known-asset-tag set; the "flag this scan / not in the active move"
-- decision is made on the Pi at scan time by subtracting the active move's
-- own assets (cloud_sync_moves_assets) — see app/rfid_scan_processing.py.
--
-- PK on id_hex makes the per-scan membership check an O(1) index hit even at
-- 50k+ rows. Bulk-replaced (TRUNCATE + INSERT) on every sync.

BEGIN;

CREATE TABLE IF NOT EXISTS local_asset_tags (
    id_hex     TEXT PRIMARY KEY,   -- upstream assets.rfid_tag
    serial     TEXT,               -- assets.serial_number (for the alert description)
    name       TEXT,               -- assets.name
    synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
