-- Generalized system-events channel. Any Pi-side subsystem (sync,
-- engine, RFID poller, etc.) can INSERT into this table; the /status
-- page subscribes to /local/system-events/stream (SSE) and prepends each
-- new row into its System Events panel.
--
-- Schema is deliberately small so producers don't have to think hard:
--   * source : short string identifying the subsystem ("sync", "reader", ...)
--   * kind   : "success" | "error" | "info" — drives the icon/color choice
--              on the panel. Free-form for future flexibility.
--   * message: short headline shown in the panel
--   * detail : optional longer text shown as a hover/title; nullable

BEGIN;

CREATE TABLE IF NOT EXISTS local_system_events (
    id          BIGSERIAL PRIMARY KEY,
    emitted_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    source      TEXT         NOT NULL,
    kind        TEXT         NOT NULL,
    message     TEXT         NOT NULL,
    detail      TEXT
);

CREATE INDEX IF NOT EXISTS local_system_events_emitted_at_idx
    ON local_system_events (emitted_at DESC);

COMMIT;
