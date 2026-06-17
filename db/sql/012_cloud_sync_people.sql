-- Local cache of the BaseCamp people roster, pulled by app/portal_sync.py
-- from GET /stackpi/sync/people. TRUNCATE + bulk-INSERT on every sync
-- cycle (same pattern as cloud_sync_moves / cloud_sync_events).
--
-- Minimal column set: only the four fields the Pi actually uses for
-- RFID/tag lookups + the upstream id as the primary key.

BEGIN;

CREATE TABLE IF NOT EXISTS cloud_sync_people (
    id              BIGINT       PRIMARY KEY,      -- upstream people.id
    first_name      TEXT,
    last_name       TEXT,
    display_name    TEXT,
    rfid_tracker    TEXT,
    synced_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Lookup by rfid_tracker is the primary use case once tag→person
-- resolution is wired up. Partial index skips rows that have no tracker.
CREATE INDEX IF NOT EXISTS cloud_sync_people_rfid_idx
    ON cloud_sync_people (rfid_tracker)
    WHERE rfid_tracker IS NOT NULL;

COMMIT;
