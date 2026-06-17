-- Add admin_password to readers so we can authenticate when polling /
-- configuring them. Plain-text is acceptable for this local-only DB; if
-- we later expose this beyond LAN we'll need to encrypt at rest.

BEGIN;

ALTER TABLE local_rfid_readers
    ADD COLUMN IF NOT EXISTS admin_password TEXT;

COMMIT;
