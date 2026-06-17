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
import logging
from typing import Any, Dict, Optional

import requests
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.portal_sync import _get_access_token

log = logging.getLogger("stackpi.setup")
router = APIRouter(prefix="/local/setup", tags=["local-setup"])

_TIMEOUT = 10


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


@router.post("/reader-settings")
def set_reader_settings(body: ReaderSettingsRequest) -> Dict[str, Any]:
    """Set the reader's site + scan type on the portal, matched by name
    (proxies BaseCampV2 PATCH /stackpi/rfid/reader-settings)."""
    return _basecamp("PATCH", "/stackpi/rfid/reader-settings", {
        "reader_name": body.reader_name,
        "site_id": body.site_id,
        "scan_type_id": body.scan_type_id,
    })
