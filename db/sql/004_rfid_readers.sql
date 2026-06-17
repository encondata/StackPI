-- Configured RFID readers. One row per physical reader the engine should
-- poll. Status fields (last_seen_at, enabled) are updated by the engine
-- as it actually talks to the device.

BEGIN;

CREATE TABLE IF NOT EXISTS local_rfid_readers (
    id            BIGSERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    reader_type   TEXT,
    address       TEXT NOT NULL,
    port          INTEGER,
    antennas      INTEGER,
    notes         TEXT,
    enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    last_seen_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS local_rfid_readers_enabled_idx
    ON local_rfid_readers (enabled);

COMMIT;
