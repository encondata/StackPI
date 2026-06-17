-- Status + auth + pinned-cert columns for the reader rows. The cert is
-- captured on the first successful "Test connection" call (Trust-On-First-
-- Use); every subsequent call must match it to detect MITM/cert rotation.

BEGIN;

ALTER TABLE local_rfid_readers
    ADD COLUMN IF NOT EXISTS admin_username  TEXT NOT NULL DEFAULT 'admin',
    ADD COLUMN IF NOT EXISTS cert_pem        TEXT,
    ADD COLUMN IF NOT EXISTS cert_sha256     TEXT,
    ADD COLUMN IF NOT EXISTS last_status_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_status     JSONB,
    ADD COLUMN IF NOT EXISTS last_error      TEXT;

COMMIT;
