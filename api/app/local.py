"""Pi-local endpoints. Read-only views of state that the kiosk portal
needs to render, plus actions for /config/registration. Exposed to the
local network only — no authentication."""
import json
import logging
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, List

import requests
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.config import Settings, get_settings

router = APIRouter(prefix="/local", tags=["local"])
log = logging.getLogger(__name__)

# Fields safe to expose to the local kiosk page. Notably excludes
# access_token + refresh_token.
_PUBLIC_FIELDS = (
    "status",
    "device_uuid",
    "hardware_serial",
    "name",
    "pairing_token",
    "pairing_token_expires_at",
    "link_url",
    "last_seen_at",
    "updated_at",
    "online",
    "heartbeat_ok_at",
)

_STATE_VERSION = 1

# Services the diagnostics endpoint reports on.
_TRACKED_SERVICES = (
    "stackpi-api",
    "stackpi-engine",
    "stackpi-portal",
    "stackpi-kiosk",
)


# ---------------------------------------------------------------------------
# state helpers (mirror engine/app/state.py — duplicated to avoid a cross-
# package import; intentionally small)
# ---------------------------------------------------------------------------

def _read_state(path: str) -> Dict[str, Any]:
    p = Path(path)
    if not p.exists():
        return {}
    try:
        with p.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_state(path: str, state: Dict[str, Any]) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    state = {"version": _STATE_VERSION, **state}
    fd, tmp_path = tempfile.mkstemp(prefix=".state.", dir=str(p.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2, sort_keys=True)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp_path, 0o600)
        os.replace(tmp_path, p)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _public_view(state: Dict[str, Any]) -> Dict[str, Any]:
    if not state:
        return {"status": "unknown"}
    return {k: state.get(k) for k in _PUBLIC_FIELDS}


# ---------------------------------------------------------------------------
# BaseCamp call — best-effort server-side deregister
# ---------------------------------------------------------------------------

def _call_basecamp_deregister(settings: Settings, access_token: str) -> bool:
    """Try to mark the device revoked server-side. Returns True if BaseCamp
    confirms (200) or already considered us out (401)."""
    url = f"{settings.api_base_url.rstrip('/')}/stackpi/deregister"
    try:
        resp = requests.post(
            url,
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=settings.http_timeout_seconds,
        )
    except requests.RequestException as e:
        log.warning("BaseCamp deregister network error: %s", e)
        return False
    if resp.status_code in (200, 401):
        return True
    log.warning(
        "BaseCamp deregister → %s: %s", resp.status_code, resp.text[:200]
    )
    return False


# ---------------------------------------------------------------------------
# routes
# ---------------------------------------------------------------------------

@router.get("/status")
def local_status(settings: Settings = Depends(get_settings)) -> Dict[str, Any]:
    """Public agent state + computed connectivity (Registered/Offline/Un-Registered)."""
    from app.cloud_status import compute_status  # noqa: PLC0415
    state = _read_state(settings.state_file)
    view = _public_view(state)
    view.update(compute_status(state))
    return view


@router.get("/overview")
def local_overview(settings: Settings = Depends(get_settings)) -> Dict[str, Any]:
    """Headline counts + registration state for the /config home page."""
    # Import here so we don't pull in psql machinery at import time.
    from app.db import _psql_scalar  # noqa: PLC0415

    raw_count = _psql_scalar("SELECT count(*) FROM local_rfid_raw_scans")
    last_sync = _psql_scalar(
        "SELECT last_synced_at FROM local_sync_status "
        "WHERE entity='moves_asset_list'"
    )
    state = _read_state(settings.state_file)
    try:
        rfid_count = int(raw_count) if raw_count else 0
    except ValueError:
        rfid_count = 0

    return {
        "rfid_tags_scanned": rfid_count,
        "moves_asset_list_last_sync": last_sync or None,
        "registration": {
            "status": state.get("status") or "unknown",
            "name": state.get("name"),
        },
    }


@router.get("/metrics")
def local_metrics() -> Dict[str, Any]:
    """Top-row dashboard metrics for the /status and /trucks kiosk pages.

    * tags_today    : count of local_rfid_raw_scans where event_timestamp
                      (falling back to received_at when missing) is on or
                      after today's midnight in the Pi's local timezone.
                      Resets cleanly every midnight without us tracking
                      state ourselves.
    * readers_up    : enabled readers whose last_status_at is recent (i.e.
                      the polling timer landed a successful /cloud/status
                      within the staleness window). Computed at 3x the
                      configured polling interval to allow a couple of
                      missed cycles before we call a reader down.
    * readers_total : enabled readers configured (denominator for the card)."""
    from app.db import _psql_scalar  # noqa: PLC0415
    from app.rfid_status import get_polling_refresh_minutes  # noqa: PLC0415

    def _int(v: Any) -> int:
        try:
            return int(v) if v is not None else 0
        except (TypeError, ValueError):
            return 0

    tags_today = _int(
        _psql_scalar(
            "SELECT count(*) FROM local_rfid_raw_scans "
            "WHERE COALESCE(event_timestamp, received_at) "
            "  >= date_trunc('day', NOW())"
        )
    )
    unique_tags_today = _int(
        _psql_scalar(
            "SELECT count(DISTINCT id_hex) FROM local_rfid_raw_scans "
            "WHERE COALESCE(event_timestamp, received_at) "
            "  >= date_trunc('day', NOW())"
        )
    )

    # Staleness window for "Reader is up" — 3x the configured polling
    # interval. Avoid flapping when one poll cycle misses. Minimum 3 min.
    stale_minutes = max(3, get_polling_refresh_minutes() * 3)
    readers_up = _int(
        _psql_scalar(
            "SELECT count(*) FROM local_rfid_readers "
            "WHERE enabled = true "
            f"  AND last_status_at >= NOW() - INTERVAL '{int(stale_minutes)} minutes'"
        )
    )
    readers_total = _int(
        _psql_scalar(
            "SELECT count(*) FROM local_rfid_readers WHERE enabled = true"
        )
    )

    # Last sync timestamp from the cloud_sync_meta sidecar. The Last Sync
    # card on /status binds metrics.last_sync directly, so populating it
    # here is enough — no separate fetch on the frontend.
    last_sync = _psql_scalar(
        "SELECT value FROM cloud_sync_meta WHERE key = 'last_synced_at' LIMIT 1"
    )

    # Assets card: matched/total against the active selection. Only Move
    # selections drive this — Events don't have an associated asset list
    # in cloud_sync_moves_assets. Cleared selection -> both zero.
    assets_total = 0
    assets_matched = 0
    sel = _read_active_selection()
    if sel.get("type") == "move" and sel.get("id") is not None:
        try:
            move_id = int(sel["id"])
        except (TypeError, ValueError):
            move_id = None
        if move_id is not None:
            assets_total = _int(
                _psql_scalar(
                    "SELECT count(*) FROM cloud_sync_moves_assets "
                    f"WHERE moves_id = {move_id}"
                )
            )
            # An asset counts as "matched" if its asset_rfid_tag has EVER
            # appeared as a hit in local_rfid_matches. Cumulative across
            # the whole life of the selection. DISTINCT on the assets row
            # so multiple matches for the same tag don't inflate the count.
            assets_matched = _int(
                _psql_scalar(
                    "SELECT count(DISTINCT cma.id) "
                    "FROM cloud_sync_moves_assets cma "
                    "JOIN local_rfid_matches m "
                    "  ON m.id_hex = cma.asset_rfid_tag "
                    " AND m.match_type = 'asset' "
                    f"WHERE cma.moves_id = {move_id}"
                )
            )

    return {
        "tags_today":        tags_today,
        "unique_tags_today": unique_tags_today,
        "readers_up":        readers_up,
        "readers_total":     readers_total,
        "last_sync":         last_sync or None,
        "assets_total":      assets_total,
        "assets_matched":    assets_matched,
    }


# ---------------------------------------------------------------------------
# Active Move/Event selection
# ---------------------------------------------------------------------------
#
# Single setting that names the move OR event the operator considers
# "currently active." Persisted as a JSON file on /var/lib/stackpi/ —
# the systemd StateDirectory — so it survives reboot. We deliberately do
# NOT use local_app_settings for this: that table lives in the tmpfs
# Postgres cluster, which only snapshots to USB every ~5 minutes, so a
# reboot soon after a change would lose it.
#
# Schema on disk:
#     {"type": "move" | "event" | null, "id": <int> | null, "name": <str> | null}
#
# Other Pi-side code can either hit GET /local/active-selection or read
# the file directly (it's world-readable to csg-owned services).

_ACTIVE_SELECTION_FILE = Path("/var/lib/stackpi/active_selection.json")


class ActiveSelectionRequest(BaseModel):
    """Body for POST /local/active-selection. Pass null type+id to clear
    the selection. When setting, server looks up the name from
    cloud_sync_moves / cloud_sync_events at write time so the snapshot
    survives even if the upstream row is later renamed or deleted."""
    type: Any = Field(default=None)  # "move" | "event" | null
    id:   Any = Field(default=None)  # int | null


_EMPTY_SELECTION: Dict[str, Any] = {"type": None, "id": None, "name": None}


def _read_active_selection() -> Dict[str, Any]:
    """Return {type, id, name}. Missing/unparseable file → all None."""
    try:
        with _ACTIVE_SELECTION_FILE.open("r", encoding="utf-8") as f:
            parsed = json.load(f)
    except (OSError, ValueError):
        return dict(_EMPTY_SELECTION)
    if not isinstance(parsed, dict):
        return dict(_EMPTY_SELECTION)
    return {
        "type": parsed.get("type"),
        "id":   parsed.get("id"),
        "name": parsed.get("name"),
    }


def _write_active_selection(payload: Dict[str, Any]) -> bool:
    """Atomically replace the selection file. Returns False on any IO
    failure — caller surfaces to the operator."""
    try:
        _ACTIVE_SELECTION_FILE.parent.mkdir(parents=True, exist_ok=True)
        # Atomic write: write to a sibling tempfile, fsync, rename. A
        # partial write or crash mid-update leaves the previous file
        # intact instead of producing a corrupt JSON document.
        fd, tmp_path = tempfile.mkstemp(
            prefix=".active_selection.",
            suffix=".tmp",
            dir=str(_ACTIVE_SELECTION_FILE.parent),
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(payload, f, separators=(",", ":"))
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, _ACTIVE_SELECTION_FILE)
        except Exception:
            # Clean up the temp file on failure so a half-written file
            # doesn't linger in StateDirectory.
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise
        # Mode 0640: csg can read+write, group readable (engine + api both
        # in the same group), world hidden.
        try:
            os.chmod(_ACTIVE_SELECTION_FILE, 0o640)
        except OSError:
            pass
    except OSError as e:
        log.warning("active_selection: write failed: %s", e)
        return False
    return True


def _lookup_selection_name(kind: str, row_id: int) -> str:
    """Find the cached display name for a (type, id) pair. Returns "" if
    the row isn't in the local cache (caller decides how to surface)."""
    from app.db import _psql_scalar  # noqa: PLC0415
    if kind == "move":
        sql = f"SELECT name FROM cloud_sync_moves WHERE id = {int(row_id)} LIMIT 1"
    elif kind == "event":
        sql = f"SELECT name FROM cloud_sync_events WHERE id = {int(row_id)} LIMIT 1"
    else:
        return ""
    v = _psql_scalar(sql)
    return v or ""


@router.get("/active-selection")
def get_active_selection() -> Dict[str, Any]:
    """Return the currently-selected move or event (if any)."""
    return _read_active_selection()


@router.post("/active-selection")
def set_active_selection(body: ActiveSelectionRequest) -> Dict[str, Any]:
    """Set or clear the active selection. Body shape:
        { "type": "move" | "event", "id": <int> }     # set
        { "type": null, "id": null }                  # clear
    Server snapshots the row's name at write time so the selection
    survives upstream renames/deletes."""
    from app.settings import _psql_exec  # noqa: PLC0415

    kind = body.type if isinstance(body.type, str) else None
    row_id = body.id if isinstance(body.id, int) else None

    if kind is None and row_id is None:
        snap = dict(_EMPTY_SELECTION)
        name = None
    else:
        if kind not in ("move", "event"):
            raise HTTPException(
                status_code=400,
                detail="type must be 'move' or 'event'",
            )
        if not isinstance(row_id, int):
            raise HTTPException(status_code=400, detail="id must be an integer")
        name = _lookup_selection_name(kind, row_id)
        snap = {"type": kind, "id": int(row_id), "name": name}

    if not _write_active_selection(snap):
        raise HTTPException(
            status_code=500, detail="failed to persist active selection"
        )

    # Surface the change to the /status page System Events panel via the
    # generalized system-events channel. The name is embedded in the
    # message so the panel shows it without the operator hovering. The
    # name is truncated to keep the full message inside the panel column
    # at the kiosk's font size — CSS `truncate` already prevents wrap,
    # but a hard cap saves space for actually-useful characters when long
    # move titles would otherwise blow past the ellipsis.
    try:
        from app import system_events  # noqa: PLC0415
        if kind is None and row_id is None:
            message = "Active Move/Event Cleared"
            detail  = "Cleared"
        else:
            label = name or f"#{row_id}"
            # Cap at ~40 chars; long enough for most names, short enough
            # to leave room for the prefix in the panel.
            trimmed = label if len(label) <= 40 else label[:37].rstrip() + "…"
            kind_label = "Move" if kind == "move" else "Event"
            message = f"Active {kind_label} Updated: {trimmed}"
            detail  = f"{kind}: {label}"
        system_events.emit(
            "active_selection",
            system_events.KIND_INFO,
            message,
            detail,
        )
    except Exception:
        # System events are fire-and-forget by design; a logging failure
        # must never block the actual selection persistence.
        log.exception("active-selection: system_events.emit failed")

    return _read_active_selection()


@router.post("/reset-pairing")
def reset_pairing(
    settings: Settings = Depends(get_settings),
) -> Dict[str, Any]:
    """Force a fresh pairing cycle. Tells BaseCamp to revoke us, clears
    local tokens, and sets status=revoked. The engine notices on the next
    heartbeat tick (~30s) and runs /register/init to get a new pairing
    token. Preserves device_uuid + hardware_serial + name so the same
    DB row is reclaimed."""
    state = _read_state(settings.state_file)
    access_token = state.get("access_token")
    if not access_token:
        raise HTTPException(
            status_code=400,
            detail="No access token in state; device is not currently registered.",
        )

    server_ok = _call_basecamp_deregister(settings, access_token)

    state.update(
        {
            "status": "revoked",
            "access_token": None,
            "access_token_expires_at": None,
            "refresh_token": None,
            "refresh_token_expires_at": None,
            "pairing_token": None,
            "pairing_token_expires_at": None,
            "link_url": None,
        }
    )
    _write_state(settings.state_file, state)
    return {"ok": True, "server_acknowledged": server_ok}


@router.post("/deregister")
def deregister(
    settings: Settings = Depends(get_settings),
) -> Dict[str, Any]:
    """Stronger than reset-pairing — also clears device identity (uuid,
    name). The engine still re-inits, but with only hardware_serial. The
    server will reclaim the same row by serial, but everything except the
    hardware_serial is reset to defaults."""
    state = _read_state(settings.state_file)
    access_token = state.get("access_token")
    if not access_token:
        raise HTTPException(
            status_code=400,
            detail="No access token in state; device is not currently registered.",
        )

    server_ok = _call_basecamp_deregister(settings, access_token)

    hardware_serial = state.get("hardware_serial")
    _write_state(
        settings.state_file,
        {
            "status": "revoked",
            "hardware_serial": hardware_serial,
        },
    )
    return {"ok": True, "server_acknowledged": server_ok}


@router.get("/diagnostics")
def diagnostics(
    settings: Settings = Depends(get_settings),
) -> Dict[str, Any]:
    """Bundle state + service is-active + recent engine log lines for
    pasting into a bug report."""
    state_public = _public_view(_read_state(settings.state_file))

    services: Dict[str, str] = {}
    for svc in _TRACKED_SERVICES:
        try:
            r = subprocess.run(
                ["systemctl", "is-active", f"{svc}.service"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            services[svc] = (r.stdout or r.stderr).strip() or "unknown"
        except (subprocess.SubprocessError, OSError) as e:
            services[svc] = f"error: {e}"

    engine_log: List[str] = []
    try:
        r = subprocess.run(
            [
                "journalctl",
                "-u",
                "stackpi-engine.service",
                "-n",
                "30",
                "--no-pager",
                "-o",
                "short-iso",
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if r.returncode == 0:
            engine_log = r.stdout.splitlines()
        else:
            engine_log = [f"(journalctl exit {r.returncode}: {r.stderr.strip()})"]
    except (subprocess.SubprocessError, OSError) as e:
        engine_log = [f"(journalctl error: {e})"]

    return {
        "state": state_public,
        "services": services,
        "settings": {
            "api_base_url": settings.api_base_url,
            "state_file": settings.state_file,
            "environment": settings.environment,
        },
        "engine_log_tail": engine_log,
    }
