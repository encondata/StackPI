"""RFID reader management endpoints (configuration only).

Talks to postgres via the trust-auth socket; uses parameterised psql calls
(via stdin) so the inputs from the API never get into SQL text directly.

Scope of this module is intentionally narrow: CRUD over the configured
readers table and a subnet scan helper for discovering reader IPs. No
control, polling, or status-check code lives here — that was deliberately
ripped out. Tag ingest from the readers happens in `rfid_ingest.py`.
"""
import concurrent.futures
import ipaddress
import json
import logging
import socket
import subprocess
import time
from enum import Enum
from typing import Any, Dict, Generator, List, Optional

import psycopg
import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

router = APIRouter(prefix="/local/rfid", tags=["local-rfid"])
log = logging.getLogger(__name__)

DB_NAME = "stackpi"
DB_USER = "csg"
PSQL_TIMEOUT_SECONDS = 5

SCAN_DEFAULT_PORT = 443    # Zebra IoT Connector REST API (HTTPS)
SCAN_PROBE_TIMEOUT_SEC = 0.4
SCAN_MAX_WORKERS = 128
SCAN_MAX_HOSTS = 2048
SCAN_PORTS = (80, 443)            # Zebra IoT Connector REST API (HTTP / HTTPS)
ZIOTC_CONFIRM_TIMEOUT_SEC = 1.0
# The ZIOTC server answers an unauthenticated /cloud/* call with this marker.
_ZIOTC_AUTH_MARKER = "authorization header missing"


class OutputMethod(str, Enum):
    API = "api"
    MQTT = "mqtt"
    DISABLE = "disable"


class ReaderCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    reader_type: Optional[str] = Field(default=None, max_length=80)
    scheme: Optional[str] = Field(default=None, pattern=r"^https?$")
    address: str = Field(min_length=1, max_length=255)
    port: Optional[int] = Field(default=None, ge=1, le=65535)
    antennas: Optional[int] = Field(default=None, ge=1, le=64)
    admin_username: Optional[str] = Field(default=None, max_length=80)
    admin_password: Optional[str] = Field(default=None, max_length=255)
    notes: Optional[str] = Field(default=None, max_length=1000)
    production_method: OutputMethod = OutputMethod.API
    production_url: Optional[str] = Field(default=None, max_length=500)
    local_method: OutputMethod = OutputMethod.API
    local_url: Optional[str] = Field(default=None, max_length=500)


class ReaderUpdateRequest(BaseModel):
    # Same shape as ReaderCreateRequest. admin_password is treated as
    # "no change" when blank (so the UI doesn't have to round-trip the
    # current password).
    name: str = Field(min_length=1, max_length=120)
    reader_type: Optional[str] = Field(default=None, max_length=80)
    scheme: Optional[str] = Field(default=None, pattern=r"^https?$")
    address: str = Field(min_length=1, max_length=255)
    port: Optional[int] = Field(default=None, ge=1, le=65535)
    antennas: Optional[int] = Field(default=None, ge=1, le=64)
    admin_username: Optional[str] = Field(default=None, max_length=80)
    admin_password: Optional[str] = Field(default=None, max_length=255)
    notes: Optional[str] = Field(default=None, max_length=1000)
    production_method: OutputMethod = OutputMethod.API
    production_url: Optional[str] = Field(default=None, max_length=500)
    local_method: OutputMethod = OutputMethod.API
    local_url: Optional[str] = Field(default=None, max_length=500)


class ScanRequest(BaseModel):
    port: int = Field(default=SCAN_DEFAULT_PORT, ge=1, le=65535)


def _psql_json(sql: str) -> Any:
    """Run a SQL statement that returns JSON (as the only column of the only
    row). Returns parsed JSON or None on any failure."""
    try:
        proc = subprocess.run(
            ["psql", "-U", DB_USER, "-d", DB_NAME, "-tAc", sql],
            capture_output=True,
            text=True,
            timeout=PSQL_TIMEOUT_SECONDS,
        )
    except (subprocess.SubprocessError, OSError) as e:
        log.warning("psql_json invocation error: %s", e)
        return None
    if proc.returncode != 0:
        log.warning(
            "psql_json exit=%d stderr=%s", proc.returncode, proc.stderr.strip()
        )
        return None
    out = proc.stdout.strip()
    if not out:
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return None


def _psql_exec_with_params(sql: str, params: Dict[str, Any]) -> bool:
    """Execute a SQL statement with bound parameters via psql -v + stdin.

    psql's :'name' syntax single-quotes the value, so as long as we control
    `sql`, the substituted params are guaranteed safe from injection. Numeric
    params are interpolated unquoted with :name.
    """
    cmd = ["psql", "-U", DB_USER, "-d", DB_NAME, "-v", "ON_ERROR_STOP=1"]
    for k, v in params.items():
        cmd.extend(["-v", f"{k}={v if v is not None else ''}"])
    try:
        proc = subprocess.run(
            cmd,
            input=sql,
            capture_output=True,
            text=True,
            timeout=PSQL_TIMEOUT_SECONDS,
        )
    except (subprocess.SubprocessError, OSError) as e:
        log.warning("psql_exec_with_params error: %s", e)
        return False
    if proc.returncode != 0:
        log.warning(
            "psql_exec exit=%d stderr=%s", proc.returncode, proc.stderr.strip()
        )
        return False
    return True


def _get_reader_row(reader_id: int) -> Optional[Dict[str, Any]]:
    """Fetch a single reader row as a dict. Returns None if not found."""
    rows = _psql_json(
        f"""
        SELECT COALESCE(jsonb_agg(r), '[]'::jsonb) FROM (
          SELECT id, name, reader_type, scheme, address, port, antennas,
                 admin_username, admin_password
          FROM local_rfid_readers
          WHERE id = {int(reader_id)}
          LIMIT 1
        ) r
        """
    )
    if not rows:
        return None
    return rows[0]


@router.get("/readers")
def list_readers() -> Dict[str, Any]:
    """Return the configured readers + small summary counts for the page
    header cards."""
    rows = _psql_json(
        """
        SELECT COALESCE(jsonb_agg(r ORDER BY id), '[]'::jsonb)
        FROM (
          SELECT id, name, reader_type, scheme, address, port, antennas, notes,
                 enabled, created_at, updated_at,
                 admin_username,
                 production_method, production_url,
                 local_method,      local_url,
                 last_seen_at, last_status_at, last_status, last_error
          FROM local_rfid_readers
        ) r
        """
    ) or []

    counts = _psql_json(
        """
        SELECT jsonb_build_object(
          'total',  (SELECT count(*) FROM local_rfid_readers),
          'active', (SELECT count(*) FROM local_rfid_readers WHERE enabled),
          'scans',  (SELECT count(*) FROM local_rfid_raw_scans)
        )
        """
    ) or {"total": 0, "active": 0, "scans": 0}

    return {"readers": rows, "counts": counts}


@router.post("/readers")
def create_reader(body: ReaderCreateRequest) -> Dict[str, Any]:
    """Insert a new reader row. Returns the updated full payload."""
    params = {
        "name": body.name.strip(),
        "reader_type": (body.reader_type or "").strip() or None,
        "scheme": (body.scheme or "http").strip(),
        "address": body.address.strip(),
        "port": body.port if body.port is not None else "NULL",
        "antennas": body.antennas if body.antennas is not None else "NULL",
        "admin_username": (body.admin_username or "admin").strip() or "admin",
        "admin_password": (body.admin_password or "").strip() or None,
        "notes": (body.notes or "").strip() or None,
        "production_method": body.production_method.value,
        "production_url": (body.production_url or "").strip() or None,
        "local_method": body.local_method.value,
        "local_url": (body.local_url or "").strip() or None,
    }

    sql = """
    INSERT INTO local_rfid_readers
        (name, reader_type, scheme, address, port, antennas,
         admin_username, admin_password, notes,
         production_method, production_url, local_method, local_url)
    VALUES
        (:'name', :'reader_type', :'scheme', :'address', :port, :antennas,
         :'admin_username', :'admin_password', :'notes',
         :'production_method', :'production_url',
         :'local_method',      :'local_url')
    RETURNING id;
    """
    if not _psql_exec_with_params(sql, params):
        raise HTTPException(status_code=500, detail="failed to insert reader")
    return list_readers()


@router.put("/readers/{reader_id}")
def update_reader(reader_id: int, body: ReaderUpdateRequest) -> Dict[str, Any]:
    """Update a reader's editable fields. If admin_password is blank or
    omitted, the stored password is kept (so the UI can render an empty
    password field without losing the value)."""
    existing = _get_reader_row(reader_id)
    if not existing:
        raise HTTPException(status_code=404, detail="reader not found")

    new_password = (body.admin_password or "").strip()
    params: Dict[str, Any] = {
        "id": int(reader_id),
        "name": body.name.strip(),
        "reader_type": (body.reader_type or "").strip() or None,
        "scheme": (body.scheme or "http").strip(),
        "address": body.address.strip(),
        "port": body.port if body.port is not None else "NULL",
        "antennas": body.antennas if body.antennas is not None else "NULL",
        "admin_username": (body.admin_username or "admin").strip() or "admin",
        "notes": (body.notes or "").strip() or None,
        "production_method": body.production_method.value,
        "production_url": (body.production_url or "").strip() or None,
        "local_method": body.local_method.value,
        "local_url": (body.local_url or "").strip() or None,
    }

    set_parts = [
        "name = :'name'",
        "reader_type = :'reader_type'",
        "scheme = :'scheme'",
        "address = :'address'",
        "port = :port",
        "antennas = :antennas",
        "admin_username = :'admin_username'",
        "notes = :'notes'",
        "production_method = :'production_method'",
        "production_url = :'production_url'",
        "local_method = :'local_method'",
        "local_url = :'local_url'",
        "updated_at = NOW()",
    ]
    if new_password:
        set_parts.append("admin_password = :'admin_password'")
        params["admin_password"] = new_password

    sql = (
        "UPDATE local_rfid_readers SET "
        + ", ".join(set_parts)
        + " WHERE id = :id"
    )
    if not _psql_exec_with_params(sql, params):
        raise HTTPException(status_code=500, detail="failed to update reader")
    return list_readers()


@router.delete("/readers/{reader_id}")
def delete_reader(reader_id: int) -> Dict[str, Any]:
    """Hard delete a reader row. Recorded scans in local_rfid_raw_scans are
    NOT deleted."""
    existing = _get_reader_row(reader_id)
    if not existing:
        raise HTTPException(status_code=404, detail="reader not found")
    if not _psql_exec_with_params(
        "DELETE FROM local_rfid_readers WHERE id = :id",
        {"id": int(reader_id)},
    ):
        raise HTTPException(status_code=500, detail="failed to delete reader")
    return list_readers()


# ---------------------------------------------------------------------------
# subnet scan for readers
# ---------------------------------------------------------------------------

def _primary_local_cidr() -> Optional[str]:
    """Find the Pi's primary non-loopback IPv4 CIDR. Returns 'X.X.X.X/N'."""
    try:
        proc = subprocess.run(
            ["ip", "-4", "-o", "addr", "show"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (subprocess.SubprocessError, OSError):
        return None
    if proc.returncode != 0:
        return None
    for line in proc.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 4 and parts[2] == "inet":
            cidr = parts[3]
            if cidr.startswith("127."):
                continue
            return cidr
    return None


def _is_ziotc_reader(scheme: str, ip: str, timeout: float = ZIOTC_CONFIRM_TIMEOUT_SEC) -> bool:
    """Credential-free check that a host runs the Zebra ZIOTC REST API.

    Hits GET {scheme}://{ip}/cloud/version with no Authorization header. The
    ZIOTC server answers an unauthenticated /cloud/* call with a body that
    mentions "Authorization header missing" (the documented signature); some
    firmware phrases it as a jwt/authorization error. Returns False on any
    connection error, timeout, or non-matching response.
    """
    url = f"{scheme}://{ip}/cloud/version"
    try:
        resp = requests.get(url, verify=False, timeout=timeout, allow_redirects=False)
    except requests.RequestException:
        return False
    body = (resp.text or "").lower()
    if _ZIOTC_AUTH_MARKER in body:
        return True
    # Tolerate firmware variation: a jwt + authorization/token error also marks
    # the ZIOTC auth layer.
    if "jwt" in body and ("authorization" in body or "token" in body):
        return True
    return False


def _probe(host: str, port: int, timeout: float) -> Optional[str]:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect((host, port))
        return host
    except (socket.error, OSError):
        return None
    finally:
        try:
            s.close()
        except OSError:
            pass


@router.post("/scan")
def scan_for_readers(body: ScanRequest) -> Dict[str, Any]:
    """Scan the Pi's primary subnet for hosts open on the given TCP port.
    Discovery only — does not talk to the reader's REST API."""
    cidr = _primary_local_cidr()
    if not cidr:
        raise HTTPException(
            status_code=500, detail="could not determine local subnet"
        )
    try:
        net = ipaddress.ip_network(cidr, strict=False)
    except ValueError as e:
        raise HTTPException(status_code=500, detail=f"bad CIDR {cidr}: {e}")

    hosts = [str(h) for h in net.hosts()]
    if len(hosts) > SCAN_MAX_HOSTS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"subnet too large ({len(hosts)} hosts) — only /22 or smaller "
                "is scanned"
            ),
        )

    start = time.time()
    responded: List[Dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=SCAN_MAX_WORKERS) as ex:
        futures = {
            ex.submit(_probe, h, body.port, SCAN_PROBE_TIMEOUT_SEC): h
            for h in hosts
        }
        for fut in concurrent.futures.as_completed(futures):
            try:
                result = fut.result()
            except Exception:
                result = None
            if result:
                responded.append({"ip": result, "port": body.port})
    responded.sort(key=lambda r: tuple(int(p) for p in r["ip"].split(".")))
    return {
        "subnet": str(net),
        "scanned_count": len(hosts),
        "responded": responded,
        "took_seconds": round(time.time() - start, 1),
    }


# ---------------------------------------------------------------------------
# Reader status — manual trigger
# ---------------------------------------------------------------------------
#
# The actual login + /cloud/status + DB write lives in app/rfid_status.py.
# These endpoints are thin wrappers so the portal can manually trigger a
# refresh. The same module is also callable as `python -m app.rfid_status`
# from the systemd timer; the FastAPI process never owns the polling loop.

@router.post("/readers/{reader_id}/poll-status")
def poll_reader_status_route(reader_id: int) -> Dict[str, Any]:
    """Run one status refresh against the given reader, synchronously.
    Returns the same shape rfid_status.poll_one_reader produces."""
    from app.rfid_status import poll_one_reader  # noqa: PLC0415

    result = poll_one_reader(int(reader_id))
    if not result.get("ok") and result.get("error") == "reader not found":
        raise HTTPException(status_code=404, detail="reader not found")
    return result


@router.post("/readers/poll-status")
def poll_all_readers_route() -> Dict[str, Any]:
    """Run a status refresh against every enabled reader, sequentially.
    Returns a summary; individual failures are recorded per-reader, not
    raised as 5xx."""
    from app.rfid_status import poll_all_readers  # noqa: PLC0415

    return poll_all_readers()


# ---------------------------------------------------------------------------
# Reader probe — used by the Initial Setup wizard's "Add reader" step
# ---------------------------------------------------------------------------

class ReaderProbeRequest(BaseModel):
    address: str = Field(min_length=1, max_length=255)
    password: str = Field(default="", max_length=255)
    scheme: str = Field(default="https")
    port: Optional[int] = None
    admin_username: str = Field(default="admin", max_length=64)


def _extract_hostname(obj: Dict[str, Any]) -> Optional[str]:
    # Generic name extractor, applied to the /cloud/nameAndDescription body
    # first and then /cloud/status as a fallback. The exact key the FX9600 uses
    # is not pinned across firmware, so try the likely ones in preference order
    # (human name before opaque id/serial) and return None if none are present.
    status = obj
    if not isinstance(status, dict):
        return None
    # Prefer a human-friendly name over an opaque id/serial.
    for key in ("hostName", "hostname", "readerName", "name",
                "readerID", "readerId", "deviceId", "serialNumber"):
        v = status.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None


# The FX9600's standard model description. Some firmware reports the reader's
# name field as "<name> <description>" (e.g. "FX9600647D23 FX9600 RFID Reader"),
# but the cloud keys readers by the short name alone ("FX9600647D23").
_MODEL_DESC_SUFFIXES = ("FX9600 RFID Reader", "RFID Reader")


def _reader_name_from_nd(nd: Dict[str, Any]) -> Optional[str]:
    """Pull the reader's short name from a /cloud/nameAndDescription body.

    Returns just the name (e.g. "FX9600647D23"), stripping a trailing model
    description when the firmware embeds it in the name field. Uses the explicit
    description field when present, then falls back to the known FX9600 model
    suffixes. Returns None if no name field is present.
    """
    if not isinstance(nd, dict):
        return None
    name = None
    for key in ("readerName", "name", "hostName", "hostname"):
        v = nd.get(key)
        if isinstance(v, str) and v.strip():
            name = v.strip()
            break
    if not name:
        return None
    suffixes = []
    for dkey in ("description", "readerDescription", "desc"):
        d = nd.get(dkey)
        if isinstance(d, str) and d.strip():
            suffixes.append(d.strip())
    suffixes.extend(_MODEL_DESC_SUFFIXES)
    for suffix in suffixes:
        if name != suffix and name.endswith(suffix):
            name = name[: -len(suffix)].strip()
            break
    return name or None


@router.post("/readers/probe")
def probe_reader(body: ReaderProbeRequest) -> Dict[str, Any]:
    """Validate a reader is reachable (login + status) and return a
    best-effort hostname for naming, WITHOUT persisting. Used by the
    Initial Setup wizard's 'Add reader' step."""
    from app import rfid_status  # noqa: PLC0415
    from app.rfid_status import ReaderAuthError  # noqa: PLC0415

    reader = {
        "address": body.address.strip(),
        "port": body.port,
        "admin_username": (body.admin_username or "admin").strip() or "admin",
        "admin_password": body.password or "",
    }
    try:
        scheme, token = rfid_status.connect_autodetect(reader)
        reader["scheme"] = scheme
        status = rfid_status._get_status(reader, token)
    except ReaderAuthError as e:
        log.warning("reader probe auth failure for %s: %s", reader["address"], e)
        raise HTTPException(status_code=401, detail="authentication failed — check admin password")
    except Exception as e:
        log.warning("reader probe failed for %s: %s", reader["address"], e)
        raise HTTPException(status_code=502, detail=f"could not reach reader: {e}")

    # The reader's human-readable name lives at /cloud/nameAndDescription on
    # 3.29.x firmware, not in /cloud/status. Prefer that; fall back to any name
    # field in status, then to the address. Best-effort — a nameAndDescription
    # failure must not fail the probe (reachability already succeeded above).
    name_and_description = None
    name = None
    try:
        name_and_description = rfid_status._get_name_and_description(reader, token)
        # Logged so the exact field shape can be confirmed against live readers.
        log.info("reader %s nameAndDescription: %r", reader["address"], name_and_description)
        name = _reader_name_from_nd(name_and_description)
    except Exception as e:  # noqa: BLE001 - naming is best-effort
        log.warning("nameAndDescription fetch failed for %s: %s", reader["address"], e)
    hostname = name or _extract_hostname(status) or reader["address"]
    return {
        "ok": True,
        "scheme": scheme,
        "hostname": hostname,
        "status": status,
        "name_and_description": name_and_description,
    }


# ---------------------------------------------------------------------------
# RFID-section settings (key/value in local_app_settings)
# ---------------------------------------------------------------------------

_SHOW_UNMATCHED_KEY = "rfid_show_unmatched_scans"
_SHOW_UNMATCHED_DEFAULT = False


def _get_show_unmatched_bool() -> bool:
    """Read the rfid_show_unmatched_scans toggle out of local_app_settings.
    Persisted as the literal string 'true' or 'false'; everything else
    (missing row, parse failure) falls back to the default."""
    from app.settings import _get_setting_str  # noqa: PLC0415

    raw = _get_setting_str(_SHOW_UNMATCHED_KEY, "false" if not _SHOW_UNMATCHED_DEFAULT else "true")
    return raw.strip().lower() == "true"


class RFIDSettingsRequest(BaseModel):
    """Body for POST /local/rfid/settings. Min/max for the polling interval
    are validated server-side via rfid_status.set_polling_refresh_minutes
    (which clamps); we accept the full int range here so the API never
    returns a hard 422 on a value the operator can correct interactively.
    Both fields are optional so the form can update one without sending
    the other."""
    rfid_polling_refresh_minutes: Optional[int] = Field(default=None, ge=1, le=1440)
    rfid_show_unmatched_scans: Optional[bool] = Field(default=None)


@router.get("/settings")
def get_rfid_settings() -> Dict[str, Any]:
    """Return all configurable RFID-section settings, plus their defaults
    and bounds (the portal page renders these as helper text)."""
    from app.rfid_status import (  # noqa: PLC0415
        DEFAULT_POLLING_REFRESH_MINUTES,
        MAX_POLLING_REFRESH_MINUTES,
        MIN_POLLING_REFRESH_MINUTES,
        get_polling_refresh_minutes,
    )
    return {
        "rfid_polling_refresh_minutes": get_polling_refresh_minutes(),
        "rfid_polling_refresh_minutes_default": DEFAULT_POLLING_REFRESH_MINUTES,
        "rfid_polling_refresh_minutes_min": MIN_POLLING_REFRESH_MINUTES,
        "rfid_polling_refresh_minutes_max": MAX_POLLING_REFRESH_MINUTES,
        "rfid_show_unmatched_scans": _get_show_unmatched_bool(),
        "rfid_show_unmatched_scans_default": _SHOW_UNMATCHED_DEFAULT,
    }


@router.post("/settings")
def set_rfid_settings(body: RFIDSettingsRequest) -> Dict[str, Any]:
    """Persist one or both RFID-section settings. Returns the full settings
    payload so the page can refresh its state from the response without a
    follow-up GET."""
    from app.rfid_status import set_polling_refresh_minutes  # noqa: PLC0415
    from app.settings import _persist_setting  # noqa: PLC0415

    if body.rfid_polling_refresh_minutes is not None:
        try:
            set_polling_refresh_minutes(body.rfid_polling_refresh_minutes)
        except RuntimeError as e:
            raise HTTPException(status_code=500, detail=str(e))

    if body.rfid_show_unmatched_scans is not None:
        if not _persist_setting(
            _SHOW_UNMATCHED_KEY,
            "true" if body.rfid_show_unmatched_scans else "false",
        ):
            raise HTTPException(
                status_code=500,
                detail="failed to persist rfid_show_unmatched_scans",
            )

    return get_rfid_settings()


# ---------------------------------------------------------------------------
# Reader control — start / stop / mode (PUT /cloud/start, /cloud/stop,
# GET /cloud/mode). Thin wrappers around app.rfid_status so the auth +
# login + status-refresh logic stays in one place.
# ---------------------------------------------------------------------------

def _control_route(reader_id: int, action: str) -> Dict[str, Any]:
    """Shared handler for /start and /stop. Translates the library's
    'reader not found' error into a 404, surface-level mismatches into 502,
    everything else as 500."""
    from app.rfid_status import start_reader, stop_reader  # noqa: PLC0415

    fn = start_reader if action == "start" else stop_reader
    result = fn(int(reader_id))
    if result.get("ok"):
        return result
    err = result.get("error") or "unknown error"
    if err == "reader not found":
        raise HTTPException(status_code=404, detail=err)
    if "no address" in err:
        raise HTTPException(status_code=400, detail=err)
    # Treat reader-side / network failures as a 502 — our API is healthy;
    # the upstream reader is what failed.
    raise HTTPException(status_code=502, detail=err)


@router.post("/readers/{reader_id}/start")
def start_reader_route(reader_id: int) -> Dict[str, Any]:
    """PUT /cloud/start (doNotPersistState=true) against the given reader,
    then refresh /cloud/status. Returns {ok, reader_id, action, status}."""
    return _control_route(int(reader_id), "start")


@router.post("/readers/{reader_id}/stop")
def stop_reader_route(reader_id: int) -> Dict[str, Any]:
    """PUT /cloud/stop against the given reader, then refresh /cloud/status."""
    return _control_route(int(reader_id), "stop")


# ---------------------------------------------------------------------------
# Reader endpoint config — pull / commit the IoT-Connector endpointConfig
# (GET /cloud/config → READER-GATEWAY.endpointConfig; PUT /cloud/cloudConfig).
# Thin wrappers around app.rfid_status (same auth/login lives there).
# ---------------------------------------------------------------------------

class EndpointConfigRequest(BaseModel):
    # The endpointConfig subtree (data/control/management). Passed through to
    # the reader unchanged — its schema is large and reader-specific, so we
    # don't model every field.
    endpointConfig: Dict[str, Any]


def _endpoint_result(result: Dict[str, Any]) -> Dict[str, Any]:
    """Translate an rfid_status result dict into an HTTP response, mirroring
    _control_route: 404 not found, 400 no address, 502 reader/network."""
    if result.get("ok"):
        return result
    err = result.get("error") or "unknown error"
    if err == "reader not found":
        raise HTTPException(status_code=404, detail=err)
    if "no address" in err:
        raise HTTPException(status_code=400, detail=err)
    raise HTTPException(status_code=502, detail=err)


@router.get("/readers/{reader_id}/endpoint-config")
def get_endpoint_config_route(reader_id: int) -> Dict[str, Any]:
    """Login → GET /cloud/config → return READER-GATEWAY.endpointConfig
    as {ok, reader_id, endpoint_config}. endpoint_config is null when the
    reader has none set."""
    from app.rfid_status import get_endpoint_config  # noqa: PLC0415

    return _endpoint_result(get_endpoint_config(int(reader_id)))


@router.put("/readers/{reader_id}/endpoint-config")
def put_endpoint_config_route(
    reader_id: int, body: EndpointConfigRequest
) -> Dict[str, Any]:
    """Commit the endpointConfig back to the reader (read-modify-write on
    /cloud/config)."""
    from app.rfid_status import put_endpoint_config  # noqa: PLC0415

    return _endpoint_result(put_endpoint_config(int(reader_id), body.endpointConfig))


class EndpointUrlRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)


@router.post("/readers/{reader_id}/endpoint-url")
def set_endpoint_url_route(
    reader_id: int, body: EndpointUrlRequest
) -> Dict[str, Any]:
    """Point the reader's tag-data connection at the given URL (e.g. this Pi's
    /rfid-tags), preserving the rest of its config."""
    from app.rfid_status import set_endpoint_url  # noqa: PLC0415

    return _endpoint_result(set_endpoint_url(int(reader_id), body.url))


# ---------------------------------------------------------------------------
# Active reader — drives the kiosk home "RFID Reader" card
# ---------------------------------------------------------------------------
#
# The home card shows a single stoplight for the reader chosen in Initial
# Setup (persisted as local_app_settings.active_reader_name by
# app.setup.set_reader_settings) and lets the operator start/stop reading.
#
# State derivation mirrors the /status page's per-reader traffic light exactly
# (red/yellow/blue/green), with yellow taking precedence over green:
#   * offline  (red)    : last_error set, OR no last_status snapshot yet
#   * degraded (yellow) : reachable, but not every output connector is connected
#   * reading  (green)  : connectors all connected AND radioActivity == "active"
#   * online   (blue)   : connectors all connected, radio not active
# Plus "unconfigured" when no active reader name is stored or it no longer
# matches a configured reader. This endpoint is a pure DB read — it never
# contacts the reader, so the card can poll it cheaply; the reader is only
# contacted by the existing poll script (systemd timer) and on start/stop.

ACTIVE_READER_NAME_KEY = "active_reader_name"


def _derive_reader_state(last_error: Optional[str], last_status: Any) -> str:
    """Map a reader's persisted (last_error, last_status) to one of
    'offline' | 'degraded' | 'online' | 'reading'. Mirrors status/page.tsx —
    including yellow (degraded) winning over green (reading)."""
    if last_error or not isinstance(last_status, dict):
        return "offline"
    # Yellow if any output connector is non-connected, or we can't confirm any
    # (empty list) — same condition the /status page uses.
    ics = last_status.get("interfaceConnectionStatus")
    data = ics.get("data") if isinstance(ics, dict) else None
    interfaces = data if isinstance(data, list) else []
    all_connected = len(interfaces) > 0 and all(
        str((i or {}).get("connectionStatus") or "").lower() == "connected"
        for i in interfaces
    )
    if not all_connected:
        return "degraded"
    activity = last_status.get("radioActivity") or last_status.get("radioActivitiy")
    if str(activity or "").lower() == "active":
        return "reading"
    return "online"


@router.get("/active-reader")
def get_active_reader() -> Dict[str, Any]:
    """Status of the kiosk's active reader (chosen in Initial Setup), for the
    home RFID Reader card. Pure DB read — does not contact the reader.

    Returns one of:
      {"configured": false, "state": "unconfigured"}                    no active reader
      {"configured": true, "reader_id", "name", "state", ...}           otherwise
    where state is 'offline' | 'reading' | 'online'.
    """
    from app.settings import _get_setting_str  # noqa: PLC0415

    name = (_get_setting_str(ACTIVE_READER_NAME_KEY, "") or "").strip()
    if not name:
        return {"configured": False, "state": "unconfigured"}

    # _psql_json runs `psql -tAc` with no bound params, so the name is
    # single-quoted with the standard SQL '' escape before interpolation.
    name_literal = "'" + name.replace("'", "''") + "'"
    rows = _psql_json(
        f"""
        SELECT COALESCE(jsonb_agg(r ORDER BY id), '[]'::jsonb) FROM (
          SELECT id, name, enabled, last_error, last_status, last_status_at
          FROM local_rfid_readers
          WHERE name = {name_literal}
          ORDER BY id
          LIMIT 1
        ) r
        """
    ) or []
    if not rows:
        # The stored name no longer matches any configured reader.
        return {"configured": False, "state": "unconfigured", "name": name}

    row = rows[0]
    state = _derive_reader_state(row.get("last_error"), row.get("last_status"))
    return {
        "configured": True,
        "reader_id": row.get("id"),
        "name": row.get("name"),
        "enabled": row.get("enabled"),
        "state": state,
        "last_status_at": row.get("last_status_at"),
        "last_error": row.get("last_error"),
    }


@router.get("/readers/{reader_id}/mode")
def get_reader_mode_route(reader_id: int) -> Dict[str, Any]:
    """GET /cloud/mode with {verbose: true}. Returns {ok, reader_id, mode}.
    Not persisted to the DB — render the returned `mode` payload directly."""
    from app.rfid_status import get_reader_mode  # noqa: PLC0415

    result = get_reader_mode(int(reader_id))
    if result.get("ok"):
        return result
    err = result.get("error") or "unknown error"
    if err == "reader not found":
        raise HTTPException(status_code=404, detail=err)
    if "no address" in err:
        raise HTTPException(status_code=400, detail=err)
    raise HTTPException(status_code=502, detail=err)


# ---------------------------------------------------------------------------
# Live scan stream — Server-Sent Events
# ---------------------------------------------------------------------------
#
# The /status page subscribes to this and prepends each event to the RFID
# Activity panel. We send a small backlog of the most recent scans on
# connect (oldest-first, so the client prepending each gets newest-on-top),
# then tail the table with a monotonic id cursor on a short poll loop.
#
# The endpoint stays open for as long as the browser tab keeps the
# EventSource alive. A heartbeat comment frame every ~15s keeps the
# connection from being closed by intermediaries (Next.js rewrite proxy,
# load balancers, etc.).

SCAN_STREAM_DB_URL  = "postgresql://csg:csg@localhost:5432/stackpi"
SCAN_STREAM_BACKLOG = 50          # most-recent rows to ship on connect
SCAN_STREAM_POLL_INTERVAL_SEC = 0.4
SCAN_STREAM_BATCH_LIMIT       = 200
SCAN_STREAM_HEARTBEAT_EVERY_SEC = 15.0


def _scan_to_event(row: tuple) -> str:
    """Render a (id, id_hex, reader_name, event_ts) row as an SSE 'data:'
    frame. Time is sent as UTC ISO 8601; the client formats it however it
    likes (the /status page wants 24h local time)."""
    scan_id, id_hex, reader_name, event_ts = row
    payload = {
        "id": int(scan_id),
        "id_hex": id_hex,
        "reader_name": reader_name or "Unknown",
        "event_timestamp": event_ts.isoformat() if event_ts is not None else None,
    }
    return f"data: {json.dumps(payload)}\n\n"


_SCAN_TAIL_SQL = """
SELECT s.id, s.id_hex,
       COALESCE(r.name, 'Unknown') AS reader_name,
       COALESCE(s.event_timestamp, s.received_at) AS event_ts
FROM   local_rfid_raw_scans s
LEFT JOIN local_rfid_readers r ON s.reader_id = r.id
WHERE  s.id > %s
ORDER  BY s.id ASC
LIMIT  %s
"""

_SCAN_BACKLOG_SQL = """
SELECT s.id, s.id_hex,
       COALESCE(r.name, 'Unknown') AS reader_name,
       COALESCE(s.event_timestamp, s.received_at) AS event_ts
FROM   local_rfid_raw_scans s
LEFT JOIN local_rfid_readers r ON s.reader_id = r.id
ORDER  BY s.id DESC
LIMIT  %s
"""


def _stream_scans() -> Generator[str, None, None]:
    """SSE generator: backlog (oldest-first so the client prepending gets
    newest-on-top), then tail with a monotonic id cursor."""
    last_id = 0
    last_heartbeat = time.monotonic()

    with psycopg.connect(SCAN_STREAM_DB_URL) as conn:
        conn.autocommit = True

        with conn.cursor() as cur:
            cur.execute(_SCAN_BACKLOG_SQL, (SCAN_STREAM_BACKLOG,))
            backlog = cur.fetchall()
        backlog.reverse()
        for row in backlog:
            last_id = max(last_id, int(row[0]))
            yield _scan_to_event(row)

        if last_id == 0:
            with conn.cursor() as cur:
                cur.execute("SELECT COALESCE(MAX(id), 0) FROM local_rfid_raw_scans")
                row = cur.fetchone()
                last_id = int(row[0]) if row and row[0] is not None else 0

        yield ": connected\n\n"

        while True:
            time.sleep(SCAN_STREAM_POLL_INTERVAL_SEC)
            try:
                with conn.cursor() as cur:
                    cur.execute(_SCAN_TAIL_SQL, (last_id, SCAN_STREAM_BATCH_LIMIT))
                    new_rows = cur.fetchall()
            except psycopg.Error:
                # Transient DB error — back off and keep streaming. The
                # browser's EventSource will reconnect if we exit anyway.
                time.sleep(1.0)
                continue

            for row in new_rows:
                last_id = max(last_id, int(row[0]))
                yield _scan_to_event(row)

            now = time.monotonic()
            if now - last_heartbeat > SCAN_STREAM_HEARTBEAT_EVERY_SEC:
                yield ": heartbeat\n\n"
                last_heartbeat = now


@router.get("/scans/stream")
def scans_stream() -> StreamingResponse:
    """SSE feed of new rows in local_rfid_raw_scans. Each event payload is
    JSON: {id, id_hex, reader_name, event_timestamp}. Backlog of the last
    50 rows on connect; heartbeat comment every ~15s."""
    headers = {
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    }
    return StreamingResponse(
        _stream_scans(),
        media_type="text/event-stream",
        headers=headers,
    )


# ---------------------------------------------------------------------------
# Live match stream — Server-Sent Events
# ---------------------------------------------------------------------------
#
# Same shape and discipline as /scans/stream above, but the source is
# local_rfid_matches (populated by app.rfid_scan_processing.process_scan
# inside the ingest transaction). The kiosk /status page subscribes to
# this for the "RFID Activity" panel.
#
# Each event payload is the union of (scan, match) so the renderer doesn't
# have to chase additional joins on the frontend:
#   {
#     "id": <scan_id>,        # stable across raw + match streams; dedupe key
#     "match_id": <m.id>,     # monotonic cursor on this stream
#     "reader_name": "...",
#     "event_timestamp": "...",
#     "match_type": "asset" | "person" | ...,
#     "match_data": {...}     # whatever the lookup function produced
#   }

MATCH_STREAM_BACKLOG = 50
MATCH_STREAM_POLL_INTERVAL_SEC = 0.4
MATCH_STREAM_BATCH_LIMIT = 200
MATCH_STREAM_HEARTBEAT_EVERY_SEC = 15.0


def _match_to_event(row: tuple) -> str:
    match_id, scan_id, match_type, match_data, reader_name, event_ts = row
    payload = {
        "id":              int(scan_id),
        "match_id":        int(match_id),
        "reader_name":     reader_name or "Unknown",
        "event_timestamp": event_ts.isoformat() if event_ts is not None else None,
        "match_type":      match_type,
        # psycopg already deserializes JSONB into a dict.
        "match_data":      match_data if isinstance(match_data, dict) else {},
    }
    return f"data: {json.dumps(payload)}\n\n"


_MATCH_BACKLOG_SQL = """
SELECT m.id, m.scan_id, m.match_type, m.match_data,
       COALESCE(r.name, 'Unknown') AS reader_name,
       COALESCE(s.event_timestamp, s.received_at) AS event_ts
FROM   local_rfid_matches m
JOIN   local_rfid_raw_scans s ON s.id = m.scan_id
LEFT JOIN local_rfid_readers r ON r.id = m.reader_id
ORDER  BY m.id DESC
LIMIT  %s
"""

_MATCH_TAIL_SQL = """
SELECT m.id, m.scan_id, m.match_type, m.match_data,
       COALESCE(r.name, 'Unknown') AS reader_name,
       COALESCE(s.event_timestamp, s.received_at) AS event_ts
FROM   local_rfid_matches m
JOIN   local_rfid_raw_scans s ON s.id = m.scan_id
LEFT JOIN local_rfid_readers r ON r.id = m.reader_id
WHERE  m.id > %s
ORDER  BY m.id ASC
LIMIT  %s
"""


def _stream_matches() -> Generator[str, None, None]:
    """SSE generator: backlog (oldest-first) then tail by match-row id."""
    last_id = 0
    last_heartbeat = time.monotonic()

    with psycopg.connect(SCAN_STREAM_DB_URL) as conn:
        conn.autocommit = True

        with conn.cursor() as cur:
            cur.execute(_MATCH_BACKLOG_SQL, (MATCH_STREAM_BACKLOG,))
            backlog = cur.fetchall()
        backlog.reverse()
        for row in backlog:
            last_id = max(last_id, int(row[0]))
            yield _match_to_event(row)

        if last_id == 0:
            with conn.cursor() as cur:
                cur.execute("SELECT COALESCE(MAX(id), 0) FROM local_rfid_matches")
                row = cur.fetchone()
                last_id = int(row[0]) if row and row[0] is not None else 0

        yield ": connected\n\n"

        while True:
            time.sleep(MATCH_STREAM_POLL_INTERVAL_SEC)
            try:
                with conn.cursor() as cur:
                    cur.execute(_MATCH_TAIL_SQL, (last_id, MATCH_STREAM_BATCH_LIMIT))
                    new_rows = cur.fetchall()
            except psycopg.Error:
                time.sleep(1.0)
                continue

            for row in new_rows:
                last_id = max(last_id, int(row[0]))
                yield _match_to_event(row)

            now = time.monotonic()
            if now - last_heartbeat > MATCH_STREAM_HEARTBEAT_EVERY_SEC:
                yield ": heartbeat\n\n"
                last_heartbeat = now


@router.get("/matches/stream")
def matches_stream() -> StreamingResponse:
    """SSE feed of new rows in local_rfid_matches with their joined scan +
    reader info. See _stream_matches docstring for payload shape."""
    headers = {
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    }
    return StreamingResponse(
        _stream_matches(),
        media_type="text/event-stream",
        headers=headers,
    )


@router.get("/upload-queue")
def upload_queue() -> Dict[str, Any]:
    """Snapshot of the scan_uploader's queue for the /config/logs page.

    Reports the count of local_rfid_processed_scans rows in each
    sync_validated state plus the adaptive batch state the uploader is
    currently operating in. Values are read directly from the DB so a
    stale upload tick can't lie about progress."""
    counts = _psql_json(
        """
        SELECT jsonb_build_object(
          'pending', COALESCE(SUM(CASE WHEN sync_validated='pending' THEN 1 ELSE 0 END), 0),
          'sent',    COALESCE(SUM(CASE WHEN sync_validated='sent'    THEN 1 ELSE 0 END), 0),
          'acked',   COALESCE(SUM(CASE WHEN sync_validated='acked'   THEN 1 ELSE 0 END), 0),
          'failed',  COALESCE(SUM(CASE WHEN sync_validated='failed'  THEN 1 ELSE 0 END), 0)
        )
        FROM local_rfid_processed_scans
        """
    ) or {"pending": 0, "sent": 0, "acked": 0, "failed": 0}

    # Mirror app.scan_uploader's constants. Hardcoded over an import to
    # keep this module free of upload-side coupling — both ends are tiny
    # and stable.
    SU_MAX_BATCH = 50
    SU_SINGLE_THRESHOLD = 20

    def _int_setting(key: str, default: int) -> int:
        raw = _psql_json(
            f"SELECT value::jsonb FROM local_app_settings WHERE key='{key}' LIMIT 1"
        )
        if raw is None:
            return default
        try:
            return int(raw)
        except (TypeError, ValueError):
            return default

    batch_size    = _int_setting("scan_upload_batch_size",   SU_MAX_BATCH)
    single_streak = _int_setting("scan_upload_single_streak", 0)

    return {
        "counts":              counts,
        "batch_size":          batch_size,
        "max_batch_size":      SU_MAX_BATCH,
        "in_single_mode":      batch_size < SU_MAX_BATCH,
        "single_streak":       single_streak,
        "single_threshold":    SU_SINGLE_THRESHOLD,
    }


@router.get("/matches/recent")
def matches_recent(limit: int = 100) -> Dict[str, Any]:
    """Most-recent N matches with their joined scan + reader info, ordered
    newest-first. Drives the matches listing on /config/logs."""
    clamped = max(1, min(int(limit or 100), 500))
    rows = _psql_json(
        f"""
        SELECT COALESCE(jsonb_agg(t ORDER BY t.match_id DESC), '[]'::jsonb)
        FROM (
          SELECT
            m.id            AS match_id,
            m.scan_id       AS scan_id,
            m.id_hex        AS id_hex,
            m.match_type    AS match_type,
            m.match_data    AS match_data,
            m.matched_at    AS matched_at,
            COALESCE(r.name, 'Unknown') AS reader_name,
            COALESCE(s.event_timestamp, s.received_at) AS event_timestamp
          FROM local_rfid_matches m
          JOIN local_rfid_raw_scans s ON s.id = m.scan_id
          LEFT JOIN local_rfid_readers r ON r.id = m.reader_id
          ORDER BY m.id DESC
          LIMIT {int(clamped)}
        ) t
        """
    ) or []
    return {"matches": rows, "limit": clamped}
