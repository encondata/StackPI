"""Device connectivity status shared across the local API.

The engine (separate service) owns registration + the heartbeat-driven
`online` flag in state.json. This module adds the API-side half: it records
the timestamp of the last SUCCESSFUL API->cloud call (sync, scan upload,
setup proxy) and computes a combined connectivity + 3-state display status
for /local/status.
"""
import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional

log = logging.getLogger("stackpi.cloud_status")

# local_app_settings keys
KEY_LAST_CLOUD_OK_AT = "device_last_cloud_ok_at"
KEY_STATUS_INTERVAL = "device_status_interval_seconds"

STATUS_INTERVAL_DEFAULT = 30
STATUS_INTERVAL_MIN = 10
STATUS_INTERVAL_MAX = 300


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def record_cloud_ok() -> None:
    """Mark 'we just reached the cloud successfully' (best-effort; never
    raises into the caller's success path)."""
    try:
        from app.settings import _persist_setting  # noqa: PLC0415
        _persist_setting(KEY_LAST_CLOUD_OK_AT, _now_iso())
    except Exception as e:  # pragma: no cover - best effort
        log.debug("record_cloud_ok failed: %s", e)


def get_status_interval_seconds() -> int:
    from app.settings import _get_setting_int  # noqa: PLC0415
    return _get_setting_int(
        KEY_STATUS_INTERVAL, STATUS_INTERVAL_DEFAULT, STATUS_INTERVAL_MIN, STATUS_INTERVAL_MAX
    )


def _parse_iso(s: Any) -> Optional[datetime]:
    if not isinstance(s, str) or not s:
        return None
    try:
        d = datetime.fromisoformat(s)
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _within(ts: Optional[datetime], window_s: int) -> bool:
    if ts is None:
        return False
    age = (datetime.now(timezone.utc) - ts).total_seconds()
    return 0 <= age <= window_s


def compute_status(state: Dict[str, Any]) -> Dict[str, Any]:
    """Given the engine state.json dict, return connectivity + display_status.

    connectivity: 'online' | 'offline'
    display_status: 'registered' | 'offline' | 'unregistered'

    Rules:
      * Not registered -> display 'unregistered' (connectivity still reported).
      * Registered: OFFLINE only when the engine reports online=False AND there
        has been no successful cloud contact (heartbeat OR API call) within the
        freshness window (3x the configured interval, min 90s). Otherwise online.
        This avoids false-offline: any recent 200 keeps it green.
    """
    from app.settings import _get_setting_str  # noqa: PLC0415

    reg = state.get("status") or "unknown"
    interval = get_status_interval_seconds()
    window = max(90, interval * 3)

    last_cloud_ok = _parse_iso(_get_setting_str(KEY_LAST_CLOUD_OK_AT, ""))
    hb_ok = _parse_iso(state.get("heartbeat_ok_at"))
    recent_ok = _within(last_cloud_ok, window) or _within(hb_ok, window)

    engine_online = state.get("online")  # True/False/None (None = unknown yet)
    # Offline only with positive evidence of disconnection and no recent success.
    offline = (engine_online is False) and not recent_ok

    connectivity = "offline" if offline else "online"
    if reg != "registered":
        display = "unregistered"
    else:
        display = "offline" if offline else "registered"
    return {"connectivity": connectivity, "display_status": display}
