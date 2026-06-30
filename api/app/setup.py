"""Device-side proxy endpoints for the kiosk Initial Setup wizard.

The wizard runs on the kiosk and needs a handful of portal-backed lookups
(move source/destination sites, RFID scan types) plus the ability to bind a
reader to a site + scan type on the portal. Rather than ship a portal access
token to the browser, the wizard calls these `/local/setup/*` endpoints and we
forward the request to the new BaseCampV2 `/stackpi` endpoints using the
engine's device Bearer token (read out of the engine's state.json).

Auth posture mirrors app.portal_sync._fetch_endpoint:
  * The device Bearer token lives in the engine state file; we read it via
    portal_sync._get_access_token(). We never refresh it from here — the
    engine's heartbeat loop owns token rotation.
  * 401 from BaseCamp -> 401 (token expired), 404 -> 404, other 4xx/5xx ->
    502 (upstream error), transport failure -> 502, missing token -> 409
    (device not registered yet).
"""
import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional

import requests
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.portal_sync import _get_access_token

log = logging.getLogger("stackpi.setup")
router = APIRouter(prefix="/local/setup", tags=["local-setup"])

_TIMEOUT = 10

# Durable reader site/scan-type snapshot. Stored on the systemd StateDirectory
# (NOT local_app_settings, which is tmpfs and loses recent writes on a power
# cut) so the config page can show the current setting across reboots. Mirrors
# the active_selection.json pattern in app.local.
_READER_SETTINGS_FILE = Path("/var/lib/stackpi/reader_settings.json")
_EMPTY_READER_SETTINGS: Dict[str, Any] = {
    "reader_name": None, "site_id": None, "site_name": None,
    "scan_type_id": None, "scan_type_name": None,
}


def _read_reader_settings() -> Dict[str, Any]:
    """Return the persisted snapshot, or all-None if missing/unparseable."""
    try:
        with _READER_SETTINGS_FILE.open("r", encoding="utf-8") as f:
            parsed = json.load(f)
    except (OSError, ValueError):
        return dict(_EMPTY_READER_SETTINGS)
    if not isinstance(parsed, dict):
        return dict(_EMPTY_READER_SETTINGS)
    return {k: parsed.get(k) for k in _EMPTY_READER_SETTINGS}


def _write_reader_settings(payload: Dict[str, Any]) -> bool:
    """Atomically replace the snapshot file. Returns False on any IO failure."""
    try:
        _READER_SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(
            prefix=".reader_settings.", suffix=".tmp",
            dir=str(_READER_SETTINGS_FILE.parent),
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(payload, f, separators=(",", ":"))
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, _READER_SETTINGS_FILE)
        except Exception:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise
        try:
            os.chmod(_READER_SETTINGS_FILE, 0o640)
        except OSError:
            pass
    except OSError as e:
        log.warning("reader_settings: write failed: %s", e)
        return False
    return True


def _is_json(resp) -> bool:
    return resp.headers.get("content-type", "").lower().startswith("application/json")


def _detail(resp, fallback: str) -> str:
    """Best-effort `detail` from an error body — never raises (a malformed
    body with a JSON content-type would otherwise make `.json()` throw)."""
    if _is_json(resp):
        try:
            d = resp.json().get("detail")
            if isinstance(d, str) and d:
                return d
        except ValueError:
            pass
    return (resp.text[:200].strip() or fallback) if resp.text else fallback


def _basecamp(method: str, path: str, json_body: Optional[dict] = None) -> Any:
    """Call a BaseCampV2 /stackpi endpoint with the device Bearer token.
    Maps auth/transport failures to HTTPException, mirroring portal_sync."""
    token, base = _get_access_token()
    if not token:
        raise HTTPException(status_code=409, detail="device not registered (no access token)")
    url = f"{base.rstrip('/')}{path}"
    try:
        resp = requests.request(
            method, url,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            json=json_body,
            timeout=_TIMEOUT,
        )
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"BaseCamp transport error: {type(e).__name__}")
    if resp.status_code == 401:
        raise HTTPException(status_code=401, detail="BaseCamp token expired")
    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail=_detail(resp, "not found"))
    if resp.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"BaseCamp error {resp.status_code}: {_detail(resp, 'upstream error')}",
        )
    # Any success (<400). Record a successful cloud contact for /local/status
    # connectivity. Best-effort — never break the proxy path.
    from app.cloud_status import record_cloud_ok  # noqa: PLC0415
    record_cloud_ok()
    # An empty body (e.g. 204) is normalized to {}; a non-empty body must be
    # JSON or we treat it as an upstream fault.
    if not resp.content:
        return {}
    if not _is_json(resp):
        raise HTTPException(status_code=502, detail="BaseCamp returned non-JSON")
    try:
        return resp.json()
    except ValueError:
        raise HTTPException(status_code=502, detail="BaseCamp returned malformed JSON")


@router.get("/move-locations")
def get_move_locations(move_id: int) -> Dict[str, Any]:
    """Source/destination sites for a move (proxies BaseCampV2)."""
    return _basecamp("GET", f"/stackpi/moves/{int(move_id)}/locations")


@router.get("/scan-types")
def get_scan_types() -> Dict[str, Any]:
    """RFID scan types (proxies BaseCampV2)."""
    return _basecamp("GET", "/stackpi/sync/scan-types")


class ReaderSettingsRequest(BaseModel):
    reader_name: str = Field(min_length=1, max_length=255)
    site_id: int
    scan_type_id: int
    site_name: Optional[str] = Field(default=None, max_length=255)
    scan_type_name: Optional[str] = Field(default=None, max_length=255)


# local_app_settings key recording which reader the kiosk home card controls.
# Set when the Initial Setup commit succeeds; read by GET /local/rfid/active-reader.
ACTIVE_READER_NAME_KEY = "active_reader_name"


@router.post("/reader-settings")
def set_reader_settings(body: ReaderSettingsRequest) -> Dict[str, Any]:
    """Set the reader's site + scan type on the portal, matched by name
    (proxies BaseCampV2 PATCH /stackpi/rfid/reader-settings).

    On success we also record this reader's name locally as the kiosk's
    "active reader" so the home screen's RFID Reader card knows which reader
    to show status for and start/stop. Best-effort — a failure to persist
    the setting must not turn a successful portal commit into an error."""
    result = _basecamp("PATCH", "/stackpi/rfid/reader-settings", {
        "reader_name": body.reader_name,
        "site_id": body.site_id,
        "scan_type_id": body.scan_type_id,
    })
    from app.settings import _persist_setting  # noqa: PLC0415

    if not _persist_setting(ACTIVE_READER_NAME_KEY, body.reader_name.strip()):
        log.warning("failed to persist %s=%r", ACTIVE_READER_NAME_KEY, body.reader_name)
    snapshot = {
        "reader_name": body.reader_name.strip(),
        "site_id": body.site_id,
        "site_name": (body.site_name or "").strip() or None,
        "scan_type_id": body.scan_type_id,
        "scan_type_name": (body.scan_type_name or "").strip() or None,
    }
    if not _write_reader_settings(snapshot):
        log.warning("failed to persist reader settings snapshot")
    return result


@router.get("/reader-settings")
def get_reader_settings() -> Dict[str, Any]:
    """Return the persisted reader site/scan-type snapshot (or all-None)."""
    return _read_reader_settings()
