-- Per-reader event-delivery configuration. The reader can ship tag /
-- management events to a Production destination (e.g. BaseCamp) and a
-- Local destination (e.g. this Pi) over either REST API or MQTT, or
-- be disabled entirely.

BEGIN;

ALTER TABLE local_rfid_readers
    ADD COLUMN IF NOT EXISTS production_method TEXT NOT NULL DEFAULT 'api',
    ADD COLUMN IF NOT EXISTS production_url    TEXT,
    ADD COLUMN IF NOT EXISTS local_method      TEXT NOT NULL DEFAULT 'api',
    ADD COLUMN IF NOT EXISTS local_url         TEXT;

COMMIT;
