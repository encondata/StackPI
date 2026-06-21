"""Status snapshot multicast broadcaster.

Builds a compact status snapshot (metrics + reader traffic-light + registration
+ recent RFID activity + recent system events) and multicasts it on a dedicated
group/port so remote status displays can render /status + /trucks without
polling the primary. One sender → any number of displays at constant cost.

Cadence: a 5s heartbeat plus on-change — in-API paths call mark_dirty() to wake
the loop for an immediate (debounced) emit. Reader-status changes come from the
poll process (separate), so they ride the heartbeat.

Transport is shared with app.notifier (notifier._emit), but on a separate
group/port (notify_status_* settings). Best-effort: a failure never raises into
the caller and never crashes the loop. See display/status-protocol.md.
"""
import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

log = logging.getLogger("stackpi.status_broadcast")

SCHEMA_VERSION = 1
HEARTBEAT_SEC = 5.0
DEBOUNCE_SEC = 0.5          # min spacing between emits, so a burst → one send
ACTIVITY_LIMIT = 20
EVENTS_LIMIT = 20

# settings (local_app_settings)
KEY_STATUS_ENABLE = "notify_status_enable"
KEY_STATUS_GROUP = "notify_status_multicast_group"
KEY_STATUS_PORT = "notify_status_multicast_port"
KEY_STATUS_EXCLUDE = "notify_status_exclude"
DEFAULT_STATUS_GROUP = "239.10.10.11"
DEFAULT_STATUS_PORT = 5006

# Toggle catalog for the /config "what to send" tick boxes. Each entry is one
# checkbox. Metric cards map to one or more keys in the metrics dict (paired
# values like readers up/total are a single card). Selection is stored as a
# DENYLIST (KEY_STATUS_EXCLUDE, CSV of ids): default empty => send everything,
# and any card added here later is sent by default until explicitly excluded.
STATUS_CATALOG: List[Dict[str, Any]] = [
    {"id": "metric:tags_today",        "label": "Tags today",             "group": "metrics", "keys": ["tags_today"]},
    {"id": "metric:unique_tags_today", "label": "Unique tags today",      "group": "metrics", "keys": ["unique_tags_today"]},
    {"id": "metric:readers",           "label": "Readers up / total",     "group": "metrics", "keys": ["readers_up", "readers_total"]},
    {"id": "metric:last_sync",         "label": "Last sync",              "group": "metrics", "keys": ["last_sync"]},
    {"id": "metric:assets",            "label": "Assets matched / total", "group": "metrics", "keys": ["assets_total", "assets_matched"]},
    {"id": "reader",        "label": "Reader status (traffic light)",   "group": "section"},
    {"id": "registration",  "label": "Registration",                    "group": "section"},
    {"id": "activity",      "label": "Recent activity (truck matches)", "group": "section"},
    {"id": "events",        "label": "System events",                   "group": "section"},
]
CATALOG_IDS = {e["id"] for e in STATUS_CATALOG}


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

def status_enabled() -> bool:
    from app.settings import _get_setting_int  # noqa: PLC0415
    return _get_setting_int(KEY_STATUS_ENABLE, 1, 0, 1) == 1


def status_target() -> tuple:
    from app.settings import _get_setting_int, _get_setting_str  # noqa: PLC0415
    return (
        _get_setting_str(KEY_STATUS_GROUP, DEFAULT_STATUS_GROUP),
        _get_setting_int(KEY_STATUS_PORT, DEFAULT_STATUS_PORT, 1, 65535),
    )


def status_excluded() -> set:
    """Set of disabled toggle ids (the denylist). Stale ids no longer in the
    catalog are dropped so they can't accidentally suppress a reused id. If the
    setting can't be read, default to the empty set (send everything)."""
    from app.settings import _get_setting_str  # noqa: PLC0415
    try:
        raw = _get_setting_str(KEY_STATUS_EXCLUDE, "")
    except Exception:  # pragma: no cover - best effort; never break the snapshot
        return set()
    return {p.strip() for p in raw.split(",") if p.strip()} & CATALOG_IDS


# ---------------------------------------------------------------------------
# Snapshot
# ---------------------------------------------------------------------------

def _recent_events(limit: int) -> List[dict]:
    from app.rfid import _psql_json  # noqa: PLC0415
    rows = _psql_json(
        f"""
        SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.emitted_at DESC), '[]'::jsonb)
        FROM (
          SELECT id, emitted_at, source, kind, message, detail
          FROM local_system_events
          ORDER BY emitted_at DESC
          LIMIT {int(limit)}
        ) e
        """
    )
    return rows or []


def build_snapshot() -> Dict[str, Any]:
    """Assemble the status snapshot by reusing the existing data functions.
    Honors the operator's send selection (status_excluded): excluded metric
    cards are filtered out of `metrics`, and excluded sections are skipped
    entirely (no psql for them). Each source is independently guarded — one
    failure leaves that section empty rather than dropping the whole snapshot.
    Blocking (psql) — call via an executor from the async loop."""
    excluded = status_excluded()
    snap: Dict[str, Any] = {
        "v": SCHEMA_VERSION,
        "type": "status",
        "ts": datetime.now(timezone.utc).isoformat(),
        "metrics": {},
        "reader": {},
        "registration": {},
        "activity": [],
        "events": [],
    }

    # Metrics is one cheap call; build it then drop the excluded cards' keys.
    drop_keys = {
        k
        for entry in STATUS_CATALOG
        if entry["group"] == "metrics" and entry["id"] in excluded
        for k in entry.get("keys", [])
    }
    try:
        from app.local import local_metrics  # noqa: PLC0415
        m = local_metrics()
        if isinstance(m, dict):
            snap["metrics"] = {k: v for k, v in m.items() if k not in drop_keys}
    except Exception as e:  # pragma: no cover - best effort
        log.debug("snapshot metrics failed: %s", e)

    if "reader" not in excluded:
        try:
            from app.rfid import get_active_reader  # noqa: PLC0415
            ar = get_active_reader()
            if isinstance(ar, dict):
                snap["reader"] = {
                    "state": ar.get("state"),
                    "name": ar.get("name"),
                    "configured": ar.get("configured"),
                }
        except Exception as e:  # pragma: no cover
            log.debug("snapshot reader failed: %s", e)

    if "registration" not in excluded:
        try:
            from app.config import get_settings  # noqa: PLC0415
            from app.local import local_overview  # noqa: PLC0415
            ov = local_overview(get_settings())
            if isinstance(ov, dict):
                snap["registration"] = ov.get("registration", {})
        except Exception as e:  # pragma: no cover
            log.debug("snapshot registration failed: %s", e)

    if "activity" not in excluded:
        try:
            from app.rfid import matches_recent  # noqa: PLC0415
            mr = matches_recent(ACTIVITY_LIMIT)
            if isinstance(mr, dict):
                snap["activity"] = (mr.get("matches") or [])[:ACTIVITY_LIMIT]
        except Exception as e:  # pragma: no cover
            log.debug("snapshot activity failed: %s", e)

    if "events" not in excluded:
        try:
            snap["events"] = _recent_events(EVENTS_LIMIT)
        except Exception as e:  # pragma: no cover
            log.debug("snapshot events failed: %s", e)

    return snap


# ---------------------------------------------------------------------------
# Broadcast loop (5s heartbeat + on-change)
# ---------------------------------------------------------------------------

_dirty = asyncio.Event()
_loop: Optional[asyncio.AbstractEventLoop] = None


def mark_dirty() -> None:
    """Wake the broadcaster for an immediate emit. Safe to call from any thread
    (FastAPI sync endpoints run off the loop thread)."""
    loop = _loop
    if loop is None:
        return
    try:
        loop.call_soon_threadsafe(_dirty.set)
    except RuntimeError:  # loop closed
        pass


async def _run() -> None:
    log.info("status broadcaster started")
    loop = asyncio.get_event_loop()
    while True:
        try:
            try:
                await asyncio.wait_for(_dirty.wait(), timeout=HEARTBEAT_SEC)
            except asyncio.TimeoutError:
                pass  # heartbeat
            _dirty.clear()

            if status_enabled():
                snapshot = await loop.run_in_executor(None, build_snapshot)
                group, port = status_target()
                from app import notifier  # noqa: PLC0415
                notifier._emit(snapshot, group, port)

            await asyncio.sleep(DEBOUNCE_SEC)  # collapse a burst into one send
        except asyncio.CancelledError:
            log.info("status broadcaster stopping")
            raise
        except Exception as e:  # pragma: no cover - loop must never die
            log.warning("status broadcast cycle failed: %s", e)
            await asyncio.sleep(HEARTBEAT_SEC)


def start() -> "asyncio.Task":
    """Start the broadcaster task on the running loop. Returns the task."""
    global _loop
    _loop = asyncio.get_event_loop()
    return _loop.create_task(_run())


async def stop(task: Optional["asyncio.Task"]) -> None:
    if task is None:
        return
    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, Exception):  # pragma: no cover
        pass