-- Local caches of upstream (BaseCamp / api.serversherpa.com) data pulled by
-- api/app/portal_sync.py. The portal page reads from these tables; the
-- sync script TRUNCATEs + bulk-INSERTs after each successful upstream
-- fetch. Naming convention: cloud_sync_{basecamp_table_name}.
--
-- Schemas mirror the *minimal* subset returned by the upstream endpoint
-- (GET /stackpi/sync/active-events-moves) — only fields the portal page
-- actually renders, plus the joined status_name/status_color.

BEGIN;

CREATE TABLE IF NOT EXISTS cloud_sync_moves (
    id              BIGINT       PRIMARY KEY,      -- upstream moves.id
    name            TEXT,
    scheduled_start TIMESTAMPTZ,
    real_start_time TIMESTAMPTZ,
    real_end_time   TIMESTAMPTZ,
    asset_count     BIGINT,
    status_id       BIGINT,                        -- upstream status_options.id
    status_name     TEXT,                          -- joined from status_options
    status_color    TEXT,
    synced_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cloud_sync_moves_status_idx
    ON cloud_sync_moves (status_id);
CREATE INDEX IF NOT EXISTS cloud_sync_moves_scheduled_idx
    ON cloud_sync_moves (scheduled_start DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS cloud_sync_events (
    id              BIGINT       PRIMARY KEY,      -- upstream events.id
    name            TEXT,
    description     TEXT,
    event_type      TEXT,
    client          BIGINT,
    scheduled_date  TIMESTAMPTZ,
    location        TEXT,
    status_id       BIGINT,
    status_name     TEXT,
    status_color    TEXT,
    created_at      TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ,
    synced_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cloud_sync_events_status_idx
    ON cloud_sync_events (status_id);
CREATE INDEX IF NOT EXISTS cloud_sync_events_scheduled_idx
    ON cloud_sync_events (scheduled_date DESC NULLS LAST);

-- A small key/value sidecar so the portal page can show "Last synced at"
-- without joining against either table. Updated atomically by the sync
-- script after a successful TRUNCATE + INSERT cycle.
CREATE TABLE IF NOT EXISTS cloud_sync_meta (
    key             TEXT         PRIMARY KEY,
    value           TEXT,
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMIT;
