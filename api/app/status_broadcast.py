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

SCHEMA_VERSION = 2          # v2: diff + keyframe protocol (see status-protocol.md)
HEARTBEAT_SEC = 5.0         # change-detection cadence (wake at least this often)
KEYFRAME_SEC = 30.0         # full re-sync interval (cold-start / packet-loss recovery)
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
    {"id": "uptime",        "label": "Uptime",                          "group": "section"},
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

    if "uptime" not in excluded:
        snap["uptime"] = _primary_uptime()

    return snap


def _primary_uptime() -> Optional[int]:
    """This (primary) device's uptime in seconds, from /proc/uptime. The display
    mirrors the primary's status, so its Uptime card shows the primary's uptime."""
    try:
        from app.settings import _read_uptime_seconds  # noqa: PLC0415
        return _read_uptime_seconds()
    except Exception:  # pragma: no cover - best effort
        return None


# ---------------------------------------------------------------------------
# Diff (v2): scalars replaced wholesale; feeds carry only the new items by id.
# uptime is deliberately NOT diffed — it changes every second and would force a
# delta every cycle. It rides keyframes (and any delta we're already sending).
# ---------------------------------------------------------------------------

_SCALAR_SECTIONS = ("metrics", "reader", "registration")


def _new_feed_items(current: List[dict], last: List[dict]) -> List[dict]:
    last_ids = {it.get("id") for it in last if isinstance(it, dict)}
    return [it for it in current if isinstance(it, dict) and it.get("id") not in last_ids]


def _diff(current: Dict[str, Any], last: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Changed sections of `current` vs `last`, or None if nothing changed.
    Scalars are sent whole; activity/events send only the new items to append."""
    delta: Dict[str, Any] = {}
    for k in _SCALAR_SECTIONS:
        if current.get(k) != last.get(k):
            delta[k] = current.get(k)
    act = _new_feed_items(current.get("activity", []), last.get("activity", []))
    if act:
        delta["activity_new"] = act
    evt = _new_feed_items(current.get("events", []), last.get("events", []))
    if evt:
        delta["events_new"] = evt
    return delta or None


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
    from app import notifier  # noqa: PLC0415

    last_sent: Optional[Dict[str, Any]] = None  # what receivers should now hold
    last_keyframe = 0.0
    last_reader_state: Optional[str] = None      # last reader light we sent
    last_reader_kf = 0.0
    while True:
        try:
            try:
                await asyncio.wait_for(_dirty.wait(), timeout=HEARTBEAT_SEC)
            except asyncio.TimeoutError:
                pass  # heartbeat tick
            _dirty.clear()
            now = loop.time()

            # --- display status broadcast (gated by its own enable) ----------
            if status_enabled():
                current = await loop.run_in_executor(None, build_snapshot)
                group, port = status_target()
                if last_sent is None or (now - last_keyframe) >= KEYFRAME_SEC:
                    # Keyframe: the full snapshot, so cold-started / lossy
                    # receivers re-sync. (build_snapshot stamps v/type/ts.)
                    msg = dict(current)
                    msg["kind"] = "full"
                    notifier._emit(msg, group, port)
                    last_sent = current
                    last_keyframe = now
                else:
                    delta = _diff(current, last_sent)
                    if delta:  # nothing changed → nothing on the wire
                        delta.update({
                            "v": SCHEMA_VERSION,
                            "type": "status",
                            "kind": "delta",
                            "ts": current.get("ts"),
                            "uptime": current.get("uptime"),
                        })
                        notifier._emit(delta, group, port)
                        last_sent = current
            else:
                last_sent = None  # force a fresh keyframe when re-enabled

            # --- reader traffic-light → stack light (its own enable) ---------
            # Independent of the display broadcast and of the display 'reader'
            # toggle. 'reading' is live (recent scans), so a scan's mark_dirty()
            # wakeup drives green within ~0.5s; re-send on the 30s keyframe so a
            # just-powered-on light re-syncs.
            reader_state = await loop.run_in_executor(None, _reader_light_state)
            reader_kf = (now - last_reader_kf) >= KEYFRAME_SEC
            if reader_state is not None and (reader_state != last_reader_state or reader_kf):
                await loop.run_in_executor(None, notifier.send_reader_light, reader_state)
                last_reader_state = reader_state
                if reader_kf:
                    last_reader_kf = now

            await asyncio.sleep(DEBOUNCE_SEC)  # collapse a burst into one send
        except asyncio.CancelledError:
            log.info("status broadcaster stopping")
            raise
        except Exception as e:  # pragma: no cover - loop must never die
            log.warning("status broadcast cycle failed: %s", e)
            await asyncio.sleep(HEARTBEAT_SEC)


READING_WINDOW_SEC = 8  # a scan within this window ⇒ the reader is "reading"


def _recent_scan(window_sec: int = READING_WINDOW_SEC) -> bool:
    """True if any RFID scan landed within the window — a real-time 'reading'
    signal (scans hit local_rfid_raw_scans.received_at immediately, unlike the
    5-minute polled radioActivity). Cheap: indexed on received_at."""
    try:
        from app.db import _psql_scalar  # noqa: PLC0415
        v = _psql_scalar(
            "SELECT 1 FROM local_rfid_raw_scans "
            f"WHERE received_at > NOW() - INTERVAL '{int(window_sec)} seconds' LIMIT 1"
        )
        return v is not None
    except Exception:  # pragma: no cover - best effort
        return False


def _reader_light_state() -> Optional[str]:
    """Reader state for the STACK LIGHT. Connection state (offline/degraded) comes
    from the reader poll, but 'reading' is driven by live scan arrivals instead of
    the 5-minute radioActivity — so green tracks truck activity within ~1s and
    clears shortly after the last tag. Idle-connected ⇒ 'online' (light off)."""
    try:
        from app.rfid import get_active_reader  # noqa: PLC0415
        ar = get_active_reader()
    except Exception:  # pragma: no cover - best effort
        return None
    if not isinstance(ar, dict):
        return None
    base = ar.get("state")
    if base in ("offline", "degraded", "unconfigured", None):
        return base
    # connected per the poll (online/reading) → override with live scan activity.
    return "reading" if _recent_scan() else "online"


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