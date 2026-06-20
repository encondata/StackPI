"""Single-script RFID reader status poller.

ONE place that knows how to:
  1. Read a reader row (address, port, scheme, admin creds) from
     local_rfid_readers.
  2. Log in to the Zebra IoT Connector at GET /cloud/localRestLogin using
     HTTP Basic. Response body carries "JWT Token: <jwt>" — we strip the
     prefix and use it as a Bearer token.
  3. Call GET /cloud/status with that Bearer token.
  4. Persist the response into local_rfid_readers.last_status (JSONB) and
     stamp last_status_at = NOW(). On failure, persist last_error and clear
     last_status_at.

Callable two ways:
  * Library:  from app.rfid_status import poll_one_reader, poll_all_readers
  * CLI:      python -m app.rfid_status            # poll all enabled readers
              python -m app.rfid_status 3          # poll reader id=3

Auth + transport details:
  * verify=False is intentional. The Zebra firmware uses a self-signed
    cert, the Pi only talks to readers on the LAN, and the operator
    declined per-reader cert pinning. See the StackPI memory note
    `stackpi-tls-posture` for the full rationale.
  * Sequential, one reader at a time. No concurrency.

Token caching: each invocation logs in once per reader (no cross-reader
sharing, no in-memory cache across calls). Simpler, predictable, no
shared-state race conditions. If we later need to amortise the login cost
across many calls, that becomes a follow-up — for now, one log-in per poll
is fine at a 5-minute cadence.
"""
import copy
import json
import logging
import subprocess
import sys
from typing import Any, Dict, List, Optional

import requests
import urllib3

# Stop urllib3 from spamming the journal every call with a self-signed-cert
# warning. The posture is documented above.
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

log = logging.getLogger(__name__)

DB_NAME = "stackpi"
DB_USER = "csg"
PSQL_TIMEOUT_SECONDS = 5

# Per-call timeouts. Login and status are both quick when the reader is
# healthy; we cap each one so a stuck reader can't hang a polling cycle.
LOGIN_TIMEOUT_SEC = 10.0
STATUS_TIMEOUT_SEC = 10.0
# Start/stop can take a beat longer than a plain status read on a busy
# reader; give them a bit more headroom but don't let one stall the timer.
ACTION_TIMEOUT_SEC = 15.0
MODE_TIMEOUT_SEC = 10.0
# Config get/put move a larger JSON document (the full reader/endpoint config),
# so allow a touch more headroom than a plain status read.
CONFIG_TIMEOUT_SEC = 15.0

# Zebra's login response prepends this literal string before the JWT.
JWT_PREFIX = "JWT Token:"

# --- RFID polling settings ---------------------------------------------------
# Stored in local_app_settings under this key; readers from the systemd timer
# and from API call sites pull it through get_polling_refresh_minutes().
SETTING_KEY_POLLING_REFRESH = "rfid_polling_refresh_minutes"
DEFAULT_POLLING_REFRESH_MINUTES = 5
MIN_POLLING_REFRESH_MINUTES = 1
MAX_POLLING_REFRESH_MINUTES = 1440  # 24h ceiling


# ---------------------------------------------------------------------------
# DB helpers (psql via subprocess — same pattern the rest of this codebase
# uses; no async SQLAlchemy etc. just to keep this file dependency-free)
# ---------------------------------------------------------------------------

def _psql_json(sql: str) -> Any:
    """Run a SELECT returning JSON. Returns parsed JSON or None on failure."""
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
    """Run a write with bound parameters via psql -v + stdin. Returns success.

    psql's :'name' syntax single-quotes the value. As long as `sql` is
    controlled, the substituted params are safe from injection.
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


def _list_enabled_readers() -> List[Dict[str, Any]]:
    """Return all enabled readers as a list of dicts. Includes admin creds."""
    rows = _psql_json(
        """
        SELECT COALESCE(jsonb_agg(r ORDER BY id), '[]'::jsonb) FROM (
          SELECT id, name, scheme, address, port,
                 admin_username, admin_password
          FROM local_rfid_readers
          WHERE enabled = true
        ) r
        """
    )
    return rows or []


def _get_reader_row(reader_id: int) -> Optional[Dict[str, Any]]:
    """Fetch one reader row by id. Returns None if not found."""
    rows = _psql_json(
        f"""
        SELECT COALESCE(jsonb_agg(r), '[]'::jsonb) FROM (
          SELECT id, name, scheme, address, port,
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


def _save_status(reader_id: int, status: Dict[str, Any]) -> bool:
    """Persist a successful /cloud/status response."""
    sql = """
    UPDATE local_rfid_readers
       SET last_status    = :'status'::jsonb,
           last_status_at = NOW(),
           last_seen_at   = NOW(),
           last_error     = NULL,
           updated_at     = NOW()
     WHERE id = :id
    """
    return _psql_exec_with_params(
        sql, {"id": int(reader_id), "status": json.dumps(status)}
    )


def _save_error(reader_id: int, error: str) -> bool:
    """Persist a failure. Leaves last_status / last_status_at unchanged so
    the UI can still show the most recent successful snapshot."""
    sql = """
    UPDATE local_rfid_readers
       SET last_error = :'error',
           updated_at = NOW()
     WHERE id = :id
    """
    return _psql_exec_with_params(
        sql, {"id": int(reader_id), "error": error[:1000]}
    )


# ---------------------------------------------------------------------------
# Polling-interval setting (local_app_settings key/value)
# ---------------------------------------------------------------------------

def _psql_get_setting(key: str) -> Optional[str]:
    """Fetch a single value from local_app_settings.value (TEXT). Returns
    None if the row doesn't exist or psql fails. `key` must be a controlled
    constant (we substitute it into the SQL — never accept it from input)."""
    try:
        proc = subprocess.run(
            [
                "psql", "-U", DB_USER, "-d", DB_NAME, "-tAc",
                f"SELECT value FROM local_app_settings "
                f"WHERE key = '{key}' LIMIT 1",
            ],
            capture_output=True,
            text=True,
            timeout=PSQL_TIMEOUT_SECONDS,
        )
    except (subprocess.SubprocessError, OSError) as e:
        log.warning("psql_get_setting error: %s", e)
        return None
    if proc.returncode != 0:
        return None
    out = proc.stdout.strip()
    return out if out else None


def _clamp_minutes(v: int) -> int:
    return max(MIN_POLLING_REFRESH_MINUTES, min(MAX_POLLING_REFRESH_MINUTES, int(v)))


def get_polling_refresh_minutes() -> int:
    """Read RFID_Polling_Refresh from local_app_settings. Falls back to
    DEFAULT_POLLING_REFRESH_MINUTES if unset, unparseable, or DB unreachable."""
    raw = _psql_get_setting(SETTING_KEY_POLLING_REFRESH)
    if raw is None:
        return DEFAULT_POLLING_REFRESH_MINUTES
    try:
        return _clamp_minutes(int(raw))
    except (TypeError, ValueError):
        return DEFAULT_POLLING_REFRESH_MINUTES


def set_polling_refresh_minutes(minutes: int) -> int:
    """Persist a new RFID_Polling_Refresh value. Clamps to allowed range and
    returns the actually-stored value. Raises ValueError if the input can't
    be coerced to int; the caller (API layer) translates that to a 400."""
    clamped = _clamp_minutes(minutes)
    sql = (
        "INSERT INTO local_app_settings (key, value) "
        f"VALUES ('{SETTING_KEY_POLLING_REFRESH}', :'value') "
        "ON CONFLICT (key) DO UPDATE "
        "SET value = EXCLUDED.value, updated_at = NOW()"
    )
    if not _psql_exec_with_params(sql, {"value": str(clamped)}):
        raise RuntimeError("failed to persist rfid_polling_refresh_minutes")
    return clamped


# ---------------------------------------------------------------------------
# Reader HTTP
# ---------------------------------------------------------------------------

def _base_url(reader: Dict[str, Any]) -> str:
    scheme = (reader.get("scheme") or "http").strip()
    host = (reader.get("address") or "").strip()
    port_val = reader.get("port")
    try:
        port = int(port_val) if port_val is not None else (80 if scheme == "http" else 443)
    except (TypeError, ValueError):
        port = 80 if scheme == "http" else 443
    return f"{scheme}://{host}:{port}"


def _strip_jwt_prefix(raw: str) -> str:
    """Strip Zebra's literal 'JWT Token:' prefix. Tolerant of extra
    whitespace and surrounding quotes."""
    s = (raw or "").strip().strip('"')
    if s.startswith(JWT_PREFIX):
        s = s[len(JWT_PREFIX):].strip()
    return s


def _login(reader: Dict[str, Any]) -> str:
    """Fetch a fresh JWT for this reader via GET /cloud/localRestLogin with
    HTTP Basic. Returns the bare JWT (prefix stripped). Raises RuntimeError
    on any failure with a short message we can log/persist."""
    username = (reader.get("admin_username") or "admin").strip() or "admin"
    password = reader.get("admin_password") or ""
    url = f"{_base_url(reader)}/cloud/localRestLogin"

    try:
        resp = requests.get(
            url,
            auth=(username, password),
            verify=False,
            timeout=LOGIN_TIMEOUT_SEC,
        )
    except requests.RequestException as e:
        raise RuntimeError(f"login transport error: {type(e).__name__}: {e}")

    if resp.status_code != 200:
        raise RuntimeError(f"login HTTP {resp.status_code}: {resp.text[:200]}")

    # Response body shape varies by firmware:
    #   - plain text:  "JWT Token: eyJ..."
    #   - JSON:        {"token": "eyJ..."} or {"message": "JWT Token: eyJ..."}
    token_raw: Optional[str] = None
    ctype = resp.headers.get("content-type", "")
    if "json" in ctype.lower():
        try:
            data = resp.json()
        except ValueError:
            data = None
        if isinstance(data, dict):
            token_raw = (
                data.get("token")
                or data.get("jwt")
                or data.get("access_token")
                or data.get("message")
                or data.get("response")
            )
        elif data is not None:
            token_raw = str(data)
    if not token_raw:
        token_raw = resp.text

    token = _strip_jwt_prefix(token_raw)
    # JWT is exactly three dot-separated segments. Quick sanity check.
    if token.count(".") < 2:
        raise RuntimeError(
            f"login response did not look like a JWT (got: {token_raw[:120]!r})"
        )
    return token


def _get_status(reader: Dict[str, Any], token: str) -> Dict[str, Any]:
    """GET /cloud/status with the given bearer token. Returns parsed JSON.
    Raises RuntimeError on any non-2xx or unparseable response."""
    url = f"{_base_url(reader)}/cloud/status"
    try:
        resp = requests.get(
            url,
            headers={"Authorization": f"Bearer {token}"},
            verify=False,
            timeout=STATUS_TIMEOUT_SEC,
        )
    except requests.RequestException as e:
        raise RuntimeError(f"status transport error: {type(e).__name__}: {e}")

    if resp.status_code != 200:
        raise RuntimeError(f"status HTTP {resp.status_code}: {resp.text[:200]}")

    try:
        body = resp.json()
    except ValueError:
        raise RuntimeError(f"status non-JSON body: {resp.text[:200]}")

    if not isinstance(body, dict):
        raise RuntimeError(f"status payload not a JSON object: {type(body).__name__}")
    return body


# ---------------------------------------------------------------------------
# Control + mode (PUT /cloud/start, PUT /cloud/stop, GET /cloud/mode)
# ---------------------------------------------------------------------------

# Body for PUT /cloud/start. doNotPersistState=true keeps the started state
# transient — a reader reboot will leave the radio stopped, which is what
# the operator expects: explicit control, no auto-resume.
START_BODY = {"doNotPersistState": True}

# Body for GET /cloud/mode. verbose=true makes the reader return the full
# antenna / metadata / filter configuration in addition to the mode type.
MODE_BODY = {"verbose": True}


def _put_action(
    reader: Dict[str, Any], token: str, path: str, body: Optional[Dict[str, Any]] = None
) -> Optional[Dict[str, Any]]:
    """PUT a JSON-bodied request with the given bearer token. Used by
    /cloud/start and /cloud/stop. Returns the parsed JSON response (or None
    on an empty body), and raises RuntimeError on any non-2xx."""
    url = f"{_base_url(reader)}{path}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    try:
        resp = requests.put(
            url,
            json=body if body is not None else {},
            headers=headers,
            verify=False,
            timeout=ACTION_TIMEOUT_SEC,
        )
    except requests.RequestException as e:
        raise RuntimeError(
            f"{path} transport error: {type(e).__name__}: {e}"
        )
    if resp.status_code != 200:
        raise RuntimeError(f"{path} HTTP {resp.status_code}: {resp.text[:200]}")
    if not resp.content:
        return None
    try:
        return resp.json()
    except ValueError:
        return None


def _get_mode(reader: Dict[str, Any], token: str) -> Dict[str, Any]:
    """GET /cloud/mode with a JSON body ({verbose: true}). Returns parsed
    JSON. Yes — Zebra's REST takes a body on GET for this endpoint; we
    pass it via requests.get(json=...). Raises RuntimeError on failure."""
    url = f"{_base_url(reader)}/cloud/mode"
    try:
        resp = requests.get(
            url,
            json=MODE_BODY,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            verify=False,
            timeout=MODE_TIMEOUT_SEC,
        )
    except requests.RequestException as e:
        raise RuntimeError(f"mode transport error: {type(e).__name__}: {e}")
    if resp.status_code != 200:
        raise RuntimeError(f"mode HTTP {resp.status_code}: {resp.text[:200]}")
    try:
        body = resp.json()
    except ValueError:
        raise RuntimeError(f"mode non-JSON body: {resp.text[:200]}")
    if not isinstance(body, dict):
        raise RuntimeError(f"mode payload not a JSON object: {type(body).__name__}")
    return body


# ---------------------------------------------------------------------------
# Config (GET /cloud/config, PUT /cloud/cloudConfig)
# ---------------------------------------------------------------------------

# Where the IoT-Connector endpoint config lives inside GET /cloud/config.
_ENDPOINT_CONFIG_PATH = ("READER-GATEWAY", "endpointConfig")


def _get_config(reader: Dict[str, Any], token: str) -> Dict[str, Any]:
    """GET /cloud/config — the full reader configuration (xml + GPIO-LED +
    READER-GATEWAY, which nests endpointConfig). Raises RuntimeError on failure."""
    url = f"{_base_url(reader)}/cloud/config"
    try:
        resp = requests.get(
            url,
            headers={"Authorization": f"Bearer {token}"},
            verify=False,
            timeout=CONFIG_TIMEOUT_SEC,
        )
    except requests.RequestException as e:
        raise RuntimeError(f"config transport error: {type(e).__name__}: {e}")
    if resp.status_code != 200:
        raise RuntimeError(f"config HTTP {resp.status_code}: {resp.text[:200]}")
    try:
        body = resp.json()
    except ValueError:
        raise RuntimeError(f"config non-JSON body: {resp.text[:200]}")
    if not isinstance(body, dict):
        raise RuntimeError(f"config payload not a JSON object: {type(body).__name__}")
    return body


def _put_config(
    reader: Dict[str, Any], token: str, config: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    """PUT /cloud/config — write the full reader configuration (xml + GPIO-LED +
    READER-GATEWAY) back. This is how endpointConfig is committed: the dedicated
    /cloud/cloudConfig import endpoint does not exist on FX9600 firmware 3.29.x
    ("/cloudConfig is not a valid URI"), so we read-modify-write the whole config
    via /cloud/config (which nests endpointConfig under READER-GATEWAY). Returns
    parsed JSON (or None on empty); raises on non-2xx."""
    url = f"{_base_url(reader)}/cloud/config"
    try:
        resp = requests.put(
            url,
            json=config,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            verify=False,
            timeout=CONFIG_TIMEOUT_SEC,
        )
    except requests.RequestException as e:
        raise RuntimeError(f"config transport error: {type(e).__name__}: {e}")
    if resp.status_code != 200:
        raise RuntimeError(f"config HTTP {resp.status_code}: {resp.text[:200]}")
    if not resp.content:
        return None
    try:
        return resp.json()
    except ValueError:
        return None


def _extract_endpoint_config(config: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Pull READER-GATEWAY.endpointConfig out of a /cloud/config response.
    Returns None when the reader has no endpoint config set."""
    node: Any = config
    for key in _ENDPOINT_CONFIG_PATH:
        if not isinstance(node, dict):
            return None
        node = node.get(key)
    return node if isinstance(node, dict) else None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def get_endpoint_config(reader_id: int) -> Dict[str, Any]:
    """Login → GET /cloud/config → return READER-GATEWAY.endpointConfig.

    Returns:
      {"ok": True,  "reader_id": int, "endpoint_config": {...} | None}
      {"ok": False, "reader_id": int, "error": "<short>"}
    Never raises.
    """
    rid = int(reader_id)
    reader = _get_reader_row(rid)
    if reader is None:
        return {"ok": False, "reader_id": rid, "error": "reader not found"}
    if not (reader.get("address") or "").strip():
        return {"ok": False, "reader_id": rid, "error": "reader has no address"}
    try:
        token = _login(reader)
        config = _get_config(reader, token)
    except RuntimeError as e:
        return {"ok": False, "reader_id": rid, "error": str(e)}
    return {
        "ok": True,
        "reader_id": rid,
        "endpoint_config": _extract_endpoint_config(config),
    }


def put_endpoint_config(
    reader_id: int, endpoint_config: Dict[str, Any]
) -> Dict[str, Any]:
    """Commit a new endpointConfig to the reader via read-modify-write:
    login → GET /cloud/config → splice endpoint_config into
    READER-GATEWAY.endpointConfig → PUT /cloud/config (the whole config back,
    so every other setting is preserved). We write the full config because the
    dedicated /cloud/cloudConfig import endpoint is absent on 3.29.x firmware.

    Returns {"ok": True, "reader_id": int} or
            {"ok": False, "reader_id": int, "error": "<short>"}. Never raises.
    """
    rid = int(reader_id)
    reader = _get_reader_row(rid)
    if reader is None:
        return {"ok": False, "reader_id": rid, "error": "reader not found"}
    if not (reader.get("address") or "").strip():
        return {"ok": False, "reader_id": rid, "error": "reader has no address"}
    try:
        token = _login(reader)
        config = _get_config(reader, token)
        gateway = config.get(_ENDPOINT_CONFIG_PATH[0])
        if not isinstance(gateway, dict):
            gateway = {}
            config[_ENDPOINT_CONFIG_PATH[0]] = gateway
        gateway[_ENDPOINT_CONFIG_PATH[1]] = endpoint_config
        _put_config(reader, token, config)
    except RuntimeError as e:
        return {"ok": False, "reader_id": rid, "error": str(e)}
    return {"ok": True, "reader_id": rid}


# The data connection StackPI creates when a reader has none. Mirrors the shape
# a reader reports for an httpPost endpoint (verified live on FX9600 3.29.x): a
# single options.URL plus no-auth security. Only the URL is filled in.
_STACKPI_HTTP_CONNECTION: Dict[str, Any] = {
    "type": "httpPost",
    "name": "StackPI",
    "description": "Local StackPI",
    "options": {
        "URL": "",
        "security": {
            "authenticationType": "NONE",
            "verifyHost": False,
            "verifyPeer": False,
            "CACertificateFileLocation": "",
            "authenticationOptions": {
                "privateKeyFileLocation": "",
                "publicKeyFileLocation": "",
            },
        },
    },
}


def _apply_endpoint_url(config: Dict[str, Any], url: str) -> Dict[str, Any]:
    """Mutate a /cloud/config dict so the tag-data connection points at ``url``.

    Sets data.event's first httpPost connection's options.URL, creating the
    nesting and a StackPI connection (from the template) if absent. Every other
    connection and setting is left untouched. Returns the same config."""
    def _dict_at(parent: Dict[str, Any], key: str) -> Dict[str, Any]:
        node = parent.get(key)
        if not isinstance(node, dict):
            node = {}
            parent[key] = node
        return node

    gateway = _dict_at(config, _ENDPOINT_CONFIG_PATH[0])      # READER-GATEWAY
    endpoint = _dict_at(gateway, _ENDPOINT_CONFIG_PATH[1])    # endpointConfig
    event = _dict_at(_dict_at(endpoint, "data"), "event")
    conns = event.get("connections")
    if not isinstance(conns, list):
        conns = []
        event["connections"] = conns

    target = next(
        (c for c in conns if isinstance(c, dict) and c.get("type") == "httpPost"),
        None,
    )
    if target is None:
        target = copy.deepcopy(_STACKPI_HTTP_CONNECTION)
        conns.append(target)

    options = target.get("options")
    if not isinstance(options, dict):
        options = {}
        target["options"] = options
    options["URL"] = url
    return config


def set_endpoint_url(reader_id: int, url: str) -> Dict[str, Any]:
    """Point the reader's tag-data connection at ``url`` (e.g. this Pi's
    /rfid-tags) via read-modify-write on /cloud/config.

    Returns {"ok": True, "reader_id": int, "url": str} or
            {"ok": False, "reader_id": int, "error": "<short>"}. Never raises.
    """
    rid = int(reader_id)
    reader = _get_reader_row(rid)
    if reader is None:
        return {"ok": False, "reader_id": rid, "error": "reader not found"}
    if not (reader.get("address") or "").strip():
        return {"ok": False, "reader_id": rid, "error": "reader has no address"}
    try:
        token = _login(reader)
        config = _get_config(reader, token)
        _apply_endpoint_url(config, url)
        _put_config(reader, token, config)
    except RuntimeError as e:
        return {"ok": False, "reader_id": rid, "error": str(e)}
    return {"ok": True, "reader_id": rid, "url": url}


def poll_one_reader(reader_id: int) -> Dict[str, Any]:
    """Run one full cycle for a single reader: login → /cloud/status → save.

    Returns a result dict that the API can hand straight to the client:
      {"ok": True,  "reader_id": int, "status": {...}}      on success
      {"ok": False, "reader_id": int, "error": "<short>"}   on failure
    Never raises; failures are surfaced via the returned dict AND persisted
    to local_rfid_readers.last_error.
    """
    rid = int(reader_id)
    reader = _get_reader_row(rid)
    if reader is None:
        return {"ok": False, "reader_id": rid, "error": "reader not found"}
    if not (reader.get("address") or "").strip():
        msg = "reader has no address"
        _save_error(rid, msg)
        return {"ok": False, "reader_id": rid, "error": msg}

    try:
        token = _login(reader)
        status = _get_status(reader, token)
    except RuntimeError as e:
        msg = str(e)
        _save_error(rid, msg)
        return {"ok": False, "reader_id": rid, "error": msg}

    if not _save_status(rid, status):
        return {"ok": False, "reader_id": rid, "error": "db write failed"}

    return {"ok": True, "reader_id": rid, "status": status}


def _do_action(reader_id: int, action: str) -> Dict[str, Any]:
    """Shared body for start_reader / stop_reader. action is 'start' or 'stop'.

    Single login → PUT /cloud/{action} → GET /cloud/status. The status fetch
    reuses the same JWT (no second login) so we don't churn tokens on the
    reader. If the action succeeds but the follow-up status fetch fails, we
    still report the action as ok — the next scheduled poll will sync.
    """
    if action not in ("start", "stop"):
        return {"ok": False, "reader_id": int(reader_id), "error": f"unknown action {action!r}"}

    rid = int(reader_id)
    reader = _get_reader_row(rid)
    if reader is None:
        return {"ok": False, "reader_id": rid, "error": "reader not found"}
    if not (reader.get("address") or "").strip():
        msg = "reader has no address"
        _save_error(rid, msg)
        return {"ok": False, "reader_id": rid, "error": msg}

    try:
        token = _login(reader)
        if action == "start":
            _put_action(reader, token, "/cloud/start", START_BODY)
        else:
            _put_action(reader, token, "/cloud/stop", None)
    except RuntimeError as e:
        msg = str(e)
        _save_error(rid, msg)
        return {"ok": False, "reader_id": rid, "error": msg}

    # Action succeeded. Refresh /cloud/status with the same token so the UI
    # sees the new state immediately. A status-fetch failure here is non-fatal.
    status: Optional[Dict[str, Any]] = None
    try:
        status = _get_status(reader, token)
        _save_status(rid, status)
    except RuntimeError as e:
        log.warning("post-%s status refresh failed for reader %s: %s", action, rid, e)

    return {"ok": True, "reader_id": rid, "action": action, "status": status}


def start_reader(reader_id: int) -> Dict[str, Any]:
    """Login → PUT /cloud/start (doNotPersistState=true) → refresh status."""
    return _do_action(int(reader_id), "start")


def stop_reader(reader_id: int) -> Dict[str, Any]:
    """Login → PUT /cloud/stop → refresh status."""
    return _do_action(int(reader_id), "stop")


def get_reader_mode(reader_id: int) -> Dict[str, Any]:
    """Login → GET /cloud/mode with {verbose: true}. Returns the mode
    payload. Mode is not persisted to the DB (no column for it yet);
    callers that want to display it should render the returned dict."""
    rid = int(reader_id)
    reader = _get_reader_row(rid)
    if reader is None:
        return {"ok": False, "reader_id": rid, "error": "reader not found"}
    if not (reader.get("address") or "").strip():
        return {"ok": False, "reader_id": rid, "error": "reader has no address"}
    try:
        token = _login(reader)
        mode = _get_mode(reader, token)
    except RuntimeError as e:
        return {"ok": False, "reader_id": rid, "error": str(e)}
    return {"ok": True, "reader_id": rid, "mode": mode}


def poll_all_readers() -> Dict[str, Any]:
    """Poll every enabled reader, sequentially. Returns a summary dict. Each
    reader gets the same treatment as poll_one_reader; one failing doesn't
    stop the rest. Manual-trigger entry point — does not honor the
    RFID_Polling_Refresh interval (caller asked for it NOW)."""
    return _poll_set(_list_enabled_readers())


def poll_due_readers() -> Dict[str, Any]:
    """Poll only enabled readers whose last_status_at is older than
    RFID_Polling_Refresh minutes (or NULL). Used by the systemd timer.

    Self-throttles via DB state, so the timer can fire on a fixed short
    cadence (every minute) and the configured interval still controls how
    often each reader is actually contacted. A setting change takes effect
    on the next timer tick — no need to regenerate systemd units."""
    interval_minutes = get_polling_refresh_minutes()
    readers = _list_due_readers(interval_minutes)
    summary = _poll_set(readers)
    summary["interval_minutes"] = interval_minutes
    return summary


def _poll_set(readers: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Shared body for poll_all_readers and poll_due_readers."""
    results: List[Dict[str, Any]] = []
    success = 0
    for r in readers:
        res = poll_one_reader(int(r["id"]))
        results.append({
            "reader_id": res["reader_id"],
            "name": r.get("name"),
            "ok": res["ok"],
            "error": res.get("error"),
        })
        if res["ok"]:
            success += 1
    return {
        "total":   len(readers),
        "success": success,
        "failed":  len(readers) - success,
        "results": results,
    }


def _list_due_readers(interval_minutes: int) -> List[Dict[str, Any]]:
    """Enabled readers whose last_status_at is NULL or older than
    `interval_minutes` minutes ago. Interval is interpolated as an integer
    literal (controlled value), not a parameter, since psql -tAc doesn't
    accept bound params on a single SELECT — and a polling interval that's
    been clamped to a known int range is safe to inline."""
    safe = _clamp_minutes(interval_minutes)
    rows = _psql_json(
        f"""
        SELECT COALESCE(jsonb_agg(r ORDER BY id), '[]'::jsonb) FROM (
          SELECT id, name, scheme, address, port,
                 admin_username, admin_password
          FROM local_rfid_readers
          WHERE enabled = true
            AND (
              last_status_at IS NULL
              OR last_status_at < NOW() - INTERVAL '{safe} minutes'
            )
        ) r
        """
    )
    return rows or []


# ---------------------------------------------------------------------------
# CLI entrypoint
# ---------------------------------------------------------------------------

def _cli_main(argv: List[str]) -> int:
    """CLI entry. Three forms:

      python -m app.rfid_status            # poll only readers due per setting
      python -m app.rfid_status --all      # poll every enabled reader now
      python -m app.rfid_status <id>       # poll one reader by id (always)

    The default (no args) is what the systemd timer calls — it honors the
    RFID_Polling_Refresh interval so a 1-minute timer cadence yields the
    configured polling cadence per reader.
    """
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s %(message)s",
    )
    args = [a for a in argv[1:] if a.strip()]

    if not args:
        result = poll_due_readers()
        print(json.dumps(result, default=str, indent=2))
        return 0 if result["failed"] == 0 else 1

    if args[0] == "--all":
        result = poll_all_readers()
        print(json.dumps(result, default=str, indent=2))
        return 0 if result["failed"] == 0 else 1

    try:
        rid = int(args[0])
    except ValueError:
        print("usage: python -m app.rfid_status [--all | <reader_id>]", file=sys.stderr)
        return 2
    result = poll_one_reader(rid)
    print(json.dumps(result, default=str, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(_cli_main(sys.argv))
