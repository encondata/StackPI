-- Generic application settings as key/value pairs. New settings can be
-- added with seed INSERTs; the table itself never needs ALTER.

BEGIN;

CREATE TABLE IF NOT EXISTS local_app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hardware settings shown on the Settings page. Defaults chosen to be
-- safe when the hardware isn't actually installed.
INSERT INTO local_app_settings (key, value) VALUES
    ('stacklight_enable', 'not_installed'),
    ('audio_feedback',    'none')
ON CONFLICT (key) DO NOTHING;

COMMIT;
