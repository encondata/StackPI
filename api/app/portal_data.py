"""Routes for the /config/portal-data portal page.

Thin HTTP wrappers around app.portal_sync. The actual upstream call, DB
TRUNCATE/INSERT, and cache reads all live in that one file so the logic
stays in one place (and the systemd timer can call the CLI form of
portal_sync without going through HTTP).

No auth on these endpoints — same LAN-trust posture as the rest of
/local/*.
"""
import json
import logging
import time
from typing import Any, Dict, Generator

import psycopg
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

router = APIRouter(prefix="/local/portal-data", tags=["local-portal-data"])
log = logging.getLogger(__name__)

# Separate prefix-less router for the system-events stream. The events
# channel is generic (sync, future RFID emissions, future engine events,
# etc.) so it doesn't live under /portal-data.
system_events_router = APIRouter(
    prefix="/local/system-events", tags=["local-system-events"]
)


@router.get("/cloud-sync")
def get_cloud_sync() -> Dict[str, Any]:
    """Return the most recent locally-cached snapshot of active moves and
    events. Reads from cloud_sync_moves / cloud_sync_events; if those
    haven't been populated yet the lists are empty."""
    from app.portal_sync import read_cached  # noqa: PLC0415

    return read_cached()


@router.post("/refresh")
def refresh_cloud_sync() -> Dict[str, Any]:
    """Trigger a synchronous fetch from BaseCamp and replace the local
    cache. Returns the sync_now() result dict. On upstream/auth failures
    we 502 so the operator gets the same feedback the kiosk uses for
    upstream-side issues."""
    from app.portal_sync import sync_now  # noqa: PLC0415

    result = sync_now()
    if result.get("ok"):
        return result
    err = (result.get("error") or "").lower()
    if "no access token" in err:
        raise HTTPException(
            status_code=409,
            detail=result.get("error") or "Pi is not registered yet",
        )
    if "401" in err or "token expired" in err:
        # Engine refreshes on its own ~30s cycle — surface to the operator
        # so they know to retry rather than diagnosing as a network issue.
        raise HTTPException(
            status_code=401,
            detail=result.get("error") or "Upstream rejected the token",
        )
    raise HTTPException(
        status_code=502,
        detail=result.get("error") or "Upstream fetch failed",
    )


# ---------------------------------------------------------------------------
# Generic system events stream (SSE)
# ---------------------------------------------------------------------------
#
# Any subsystem can write to local_system_events via app.system_events.emit().
# The /status page subscribes to this stream and prepends each new row to
# the System Events panel.

SE_DB_URL                  = "postgresql://csg:csg@localhost:5432/stackpi"
SE_STREAM_BACKLOG          = 50
SE_STREAM_POLL_INTERVAL    = 0.5
SE_STREAM_BATCH_LIMIT      = 200
SE_STREAM_HEARTBEAT_EVERY  = 15.0


def _se_event(row: tuple, replay: bool = False) -> str:
    """Render a (id, emitted_at, source, kind, message, detail) row as
    an SSE 'data:' frame. `replay=True` marks rows sent from the connect-time
    backlog (vs. live tail) so consumers like the bad-tag FlashAlertOverlay
    can ignore historical alerts on page refresh / reconnect and only flash on
    a genuinely new scan. The /status events list still renders both."""
    rid, emitted_at, source, kind, message, detail = row
    payload = {
        "id":         int(rid),
        "emitted_at": emitted_at.isoformat() if emitted_at is not None else None,
        "source":     source or "",
        "kind":       kind or "info",
        "message":    message or "",
        "detail":     detail,
        "replay":     replay,
    }
    return f"data: {json.dumps(payload)}\n\n"


_SE_BACKLOG_SQL = """
SELECT id, emitted_at, source, kind, message, detail
FROM   local_system_events
ORDER  BY id DESC
LIMIT  %s
"""

_SE_TAIL_SQL = """
SELECT id, emitted_at, source, kind, message, detail
FROM   local_system_events
WHERE  id > %s
ORDER  BY id ASC
LIMIT  %s
"""


def _stream_system_events() -> Generator[str, None, None]:
    """SSE generator. Sends backlog oldest-first so the client prepending
    each ends up with newest-on-top, then tails the table by id cursor.
    Heartbeat comment every ~15 s keeps the connection open through any
    intermediary that buffers idle responses."""
    last_id = 0
    last_heartbeat = time.monotonic()

    with psycopg.connect(SE_DB_URL) as conn:
        conn.autocommit = True

        with conn.cursor() as cur:
            cur.execute(_SE_BACKLOG_SQL, (SE_STREAM_BACKLOG,))
            backlog = cur.fetchall()
        backlog.reverse()
        for row in backlog:
            last_id = max(last_id, int(row[0]))
            yield _se_event(row, replay=True)

        if last_id == 0:
            with conn.cursor() as cur:
                cur.execute("SELECT COALESCE(MAX(id), 0) FROM local_system_events")
                row = cur.fetchone()
                last_id = int(row[0]) if row and row[0] is not None else 0

        yield ": connected\n\n"

        while True:
            time.sleep(SE_STREAM_POLL_INTERVAL)
            try:
                with conn.cursor() as cur:
                    cur.execute(_SE_TAIL_SQL, (last_id, SE_STREAM_BATCH_LIMIT))
                    new_rows = cur.fetchall()
            except psycopg.Error:
                time.sleep(1.0)
                continue

            for row in new_rows:
                last_id = max(last_id, int(row[0]))
                yield _se_event(row)

            now = time.monotonic()
            if now - last_heartbeat > SE_STREAM_HEARTBEAT_EVERY:
                yield ": heartbeat\n\n"
                last_heartbeat = now


@system_events_router.get("/stream")
def system_events_stream() -> StreamingResponse:
    """SSE feed of new rows in local_system_events. Each event payload is
    JSON: {id, emitted_at, source, kind, message, detail}. Backlog of the
    most recent 50 rows on connect; heartbeat every ~15 s."""
    headers = {
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    }
    return StreamingResponse(
        _stream_system_events(),
        media_type="text/event-stream",
        headers=headers,
    )
