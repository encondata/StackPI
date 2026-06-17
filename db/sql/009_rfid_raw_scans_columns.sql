-- Flatten the Zebra IoT Connector tag-event JSON into typed columns,
-- while also keeping the raw payload in raw_json for forward compatibility.
-- The reader POSTs to the Pi at /rfid-tags; the api/app/rfid_ingest.py
-- module parses each event and inserts a row.

BEGIN;

ALTER TABLE local_rfid_raw_scans
    -- bookkeeping
    ADD COLUMN IF NOT EXISTS reader_id        BIGINT,
    ADD COLUMN IF NOT EXISTS received_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- event envelope (top-level fields in the Zebra JSON)
    ADD COLUMN IF NOT EXISTS event_type       TEXT,
    ADD COLUMN IF NOT EXISTS event_timestamp  TIMESTAMPTZ,

    -- per-event "data" object
    ADD COLUMN IF NOT EXISTS event_num        BIGINT,
    ADD COLUMN IF NOT EXISTS id_hex           TEXT,
    ADD COLUMN IF NOT EXISTS tid              TEXT,
    -- "user_data" because USER is a builtin function in postgres
    ADD COLUMN IF NOT EXISTS user_data        TEXT,
    ADD COLUMN IF NOT EXISTS crc              TEXT,
    ADD COLUMN IF NOT EXISTS pc               TEXT,
    ADD COLUMN IF NOT EXISTS xpc              TEXT,
    ADD COLUMN IF NOT EXISTS antenna          INTEGER,
    ADD COLUMN IF NOT EXISTS channel_mhz      NUMERIC(8, 3),
    -- "event_format" because format() is a builtin
    ADD COLUMN IF NOT EXISTS event_format     TEXT,
    ADD COLUMN IF NOT EXISTS peak_rssi        SMALLINT,
    ADD COLUMN IF NOT EXISTS phase            NUMERIC,
    ADD COLUMN IF NOT EXISTS reads            INTEGER,
    ADD COLUMN IF NOT EXISTS access_results   JSONB,

    -- full payload as received
    ADD COLUMN IF NOT EXISTS raw_json         JSONB;

-- Soft FK: don't cascade-delete scans when a reader row is removed.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'local_rfid_raw_scans_reader_id_fkey'
    ) THEN
        ALTER TABLE local_rfid_raw_scans
            ADD CONSTRAINT local_rfid_raw_scans_reader_id_fkey
            FOREIGN KEY (reader_id)
            REFERENCES local_rfid_readers(id)
            ON DELETE SET NULL;
    END IF;
END$$;

-- Likely query patterns
CREATE INDEX IF NOT EXISTS local_rfid_raw_scans_received_at_idx
    ON local_rfid_raw_scans (received_at DESC);
CREATE INDEX IF NOT EXISTS local_rfid_raw_scans_id_hex_idx
    ON local_rfid_raw_scans (id_hex);
CREATE INDEX IF NOT EXISTS local_rfid_raw_scans_reader_id_idx
    ON local_rfid_raw_scans (reader_id);

COMMIT;
