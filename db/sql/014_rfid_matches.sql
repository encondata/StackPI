-- local_rfid_matches: persistent log of every raw scan that the
-- rfid_scan_processing registry resolved against a known source
-- (cloud_sync_moves_assets, cloud_sync_people, …).
--
-- One row per (scan_id, lookup-hit). scan_id FKs back to the raw
-- scan so the original tag event is always recoverable. We do NOT
-- snapshot reader_name into this table — reader renames should
-- propagate to historical match displays, so the SSE / log queries
-- LEFT JOIN local_rfid_readers on reader_id at read time.
--
-- match_data is flat JSON shaped by the lookup function that hit:
--   asset:  {"match_type":"asset","asset_serial_number":...,
--            "asset_make":..., "asset_model":...}
--   person: {"match_type":"person","name":"..."}
--
-- Idempotent: re-runnable on every deploy.

CREATE TABLE IF NOT EXISTS local_rfid_matches (
    id          BIGSERIAL PRIMARY KEY,
    scan_id     BIGINT NOT NULL
                REFERENCES local_rfid_raw_scans(id) ON DELETE CASCADE,
    reader_id   BIGINT,
    id_hex      TEXT,
    match_type  TEXT NOT NULL,
    match_data  JSONB NOT NULL,
    matched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Drives the assets-matched COUNT query (cloud_sync_moves_assets
-- JOIN local_rfid_matches ON id_hex = asset_rfid_tag).
CREATE INDEX IF NOT EXISTS idx_local_rfid_matches_id_hex
    ON local_rfid_matches (id_hex);

CREATE INDEX IF NOT EXISTS idx_local_rfid_matches_scan_id
    ON local_rfid_matches (scan_id);

-- Tail cursor for /local/rfid/matches/stream uses id ordering, so
-- the PK index already covers that path.

-- /status RFID Activity hide/show toggle for unmatched scans.
-- Default: 'false' — only matches render on the kiosk page.
INSERT INTO local_app_settings (key, value)
VALUES ('rfid_show_unmatched_scans', 'false')
ON CONFLICT (key) DO NOTHING;
