-- local_rfid_processed_scans: upload queue for matched RFID scans.
--
-- Populated inline by app.rfid_scan_processing.process_scan in the SAME
-- transaction as the raw scan + match row (so a power loss leaves the
-- three tables consistent — never a raw without a match without a queued
-- upload row, when a match was found).
--
-- The future uploader reads sync_validated IN ('pending','failed') rows,
-- POSTs each to BaseCamp's scans_raw endpoint, flips to 'sent' on send,
-- and to 'acked' or 'failed' on response. Failed rows fall back into the
-- pending queue on the next retry pass.
--
-- Mirrors the matching local_rfid_raw_scans row in full so the uploader
-- has everything in one query — plus the resolved match info, plus the
-- sync state machine fields.
--
-- raw_scan_id / match_id are SOFT references on purpose (no FK). Once a
-- row is queued here it's the canonical upload record and must survive
-- any future raw_scans / matches purge.
--
-- reader_name is snapshotted at insert time. Reader names are configured
-- at site-setup and don't change in normal operation; we don't need the
-- late-binding LEFT JOIN the SSE / log queries use elsewhere.
--
-- Idempotent (re-runnable on every deploy).
--
-- One-shot migration guard: the original 001_initial.sql created an
-- empty placeholder (id-only). Drop it only when it's the placeholder
-- shape (no sync_validated column) — never when the real table is
-- already in place.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name   = 'local_rfid_processed_scans'
    )
    AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'local_rfid_processed_scans'
          AND column_name  = 'sync_validated'
    ) THEN
        DROP TABLE local_rfid_processed_scans;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS local_rfid_processed_scans (
    id                  BIGSERIAL PRIMARY KEY,

    -- Provenance (soft references — deliberately no FK)
    raw_scan_id         BIGINT NOT NULL,
    match_id            BIGINT NOT NULL,

    -- Full mirror of the matching local_rfid_raw_scans row. Column names
    -- and types match the source table 1:1 so the INSERT … SELECT in
    -- process_scan is a straight copy.
    reader_id           BIGINT,
    reader_name         TEXT,
    received_at         TIMESTAMPTZ,
    event_type          TEXT,
    event_timestamp     TIMESTAMPTZ,
    event_num           BIGINT,
    id_hex              TEXT,
    tid                 TEXT,
    user_data           TEXT,
    crc                 TEXT,
    pc                  TEXT,
    xpc                 TEXT,
    antenna             INTEGER,
    channel_mhz         NUMERIC(8,3),
    event_format        TEXT,
    peak_rssi           SMALLINT,
    phase               NUMERIC,
    reads               INTEGER,
    access_results      JSONB,
    raw_json            JSONB,

    -- Match info (same flat shape app.rfid_scan_processing emits)
    match_type          TEXT NOT NULL,
    match_data          JSONB NOT NULL,

    -- Sync state machine for the eventual uploader
    sync_validated      TEXT NOT NULL DEFAULT 'pending'
                        CHECK (sync_validated IN ('pending','sent','acked','failed')),
    sync_send_time      TIMESTAMPTZ,
    sync_validate_time  TIMESTAMPTZ,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Uploader queue scan. Partial index because 'acked' is the steady state
-- for the vast majority of rows — keeping the index tiny.
CREATE INDEX IF NOT EXISTS idx_local_rfid_processed_pending
    ON local_rfid_processed_scans (id)
    WHERE sync_validated IN ('pending','failed');

CREATE INDEX IF NOT EXISTS idx_local_rfid_processed_raw_scan_id
    ON local_rfid_processed_scans (raw_scan_id);

CREATE INDEX IF NOT EXISTS idx_local_rfid_processed_match_id
    ON local_rfid_processed_scans (match_id);
