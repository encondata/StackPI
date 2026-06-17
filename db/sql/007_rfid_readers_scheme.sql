-- Some Zebra firmware exposes the IoT Connector REST API over plain HTTP
-- (often on port 80), others over HTTPS. Track the scheme per-reader so
-- the client knows what to use. Existing rows default to http (the more
-- common case in our deployment).

-- Note: no CHECK constraint here — Postgres doesn't support
-- `ADD CONSTRAINT IF NOT EXISTS`, and the API layer already validates
-- scheme via a Pydantic pattern (^https?$).

BEGIN;

ALTER TABLE local_rfid_readers
    ADD COLUMN IF NOT EXISTS scheme TEXT NOT NULL DEFAULT 'http';

COMMIT;
