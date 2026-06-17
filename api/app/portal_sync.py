"""Single-script BaseCamp portal-data sync.

ONE place that knows how to:
  1. Read the StackPI access token out of the engine's state.json (kept
     fresh by stackpi-engine; we never write to that file).
  2. Hit GET <api.serversherpa.com>/stackpi/sync/active-events-moves with
     a Bearer token. The upstream filters by status on its side, so all
     rows we receive are already 'active'.
  3. Bulk-replace local cache tables (cloud_sync_moves, cloud_sync_events)
     in a single transaction so a partial failure leaves the previous
     snapshot intact.

Callable two ways:
  * Library:  from app.portal_sync import sync_now, read_cached
  * CLI:      python -m app.portal_sync            # sync once and print result

Auth posture:
  * If the access token is expired or rejected, we DO NOT refresh from
    here. The engine's heartbeat loop owns token rotation; it'll refresh
    on its next cycle (within ~30s) and the next sync attempt will work.
    Keeping refresh ownership single-writer avoids two processes racing
    on state.json.
  * Token TLS: standard requests + system CA bundle. No verify=False.
"""
import json
import logging
import subprocess
import sys
from typing import Any, Dict, List, Optional, Tuple

import requests

log = logging.getLogger(__name__)

# --- Config -----------------------------------------------------------------

# The engine's persisted state lives here (see deploy/services/stackpi-engine.service
# StateDirectory=stackpi). Both the engine and the api run as user 'csg', so
# the api can read this file directly.
ENGINE_STATE_FILE = "/var/lib/stackpi/state.json"

# Upstream BaseCamp / api.serversherpa.com base URL. The engine has the
# same value baked into its config; for the sync script we read it back
# out of state.json so it stays in sync if the engine config changes.
DEFAULT_API_BASE = "https://api.serversherpa.com"

# Upstream endpoints. Each one is fetched independently in sync_now() so
# we can later schedule them at different cadences without surgery.
SYNC_ENDPOINT_EVENTS_MOVES = "/stackpi/sync/active-events-moves"
SYNC_ENDPOINT_PEOPLE       = "/stackpi/sync/people"
SYNC_ENDPOINT_MOVES_ASSETS = "/stackpi/sync/active-moves-assets"
SYNC_ENDPOINT_ASSET_TAGS   = "/stackpi/sync/asset-tags"

DB_NAME = "stackpi"
DB_USER = "csg"
PSQL_TIMEOUT_SECONDS = 10

UPSTREAM_TIMEOUT_SEC = 20.0

# Sidecar keys for cloud_sync_meta.
META_KEY_LAST_SYNCED_AT  = "last_synced_at"
META_KEY_LAST_FETCHED_AT = "last_fetched_at"   # the server-side timestamp
META_KEY_LAST_ERROR      = "last_error"


# --- DB helpers (subprocess psql, mirroring the rest of this codebase) ------

def _psql_exec(sql: str) -> bool:
    """Run a single SQL statement (write). Returns True on success."""
    try:
        proc = subprocess.run(
            ["psql", "-U", DB_USER, "-d", DB_NAME, "-v", "ON_ERROR_STOP=1", "-c", sql],
            capture_output=True,
            text=True,
            timeout=PSQL_TIMEOUT_SECONDS,
        )
    except (subprocess.SubprocessError, OSError) as e:
        log.warning("psql exec error: %s", e)
        return False
    if proc.returncode != 0:
        log.warning(
            "psql exec exit=%d stderr=%s", proc.returncode, proc.stderr.strip()
        )
        return False
    return True


def _psql_exec_script(sql_script: str) -> Tuple[bool, str]:
    """Run a multi-statement script via stdin. Returns (success, stderr).
    On failure stderr carries the psql diagnostic so callers can surface
    it to the operator instead of a vague "something broke" message."""
    try:
        proc = subprocess.run(
            ["psql", "-U", DB_USER, "-d", DB_NAME, "-v", "ON_ERROR_STOP=1"],
            input=sql_script,
            capture_output=True,
            text=True,
            timeout=PSQL_TIMEOUT_SECONDS,
        )
    except (subprocess.SubprocessError, OSError) as e:
        msg = f"{type(e).__name__}: {e}"
        log.warning("psql exec_script invocation error: %s", msg)
        return False, msg
    if proc.returncode != 0:
        err = proc.stderr.strip()
        log.warning("psql exec_script exit=%d stderr=%s", proc.returncode, err)
        return False, err
    return True, ""


def _psql_json(sql: str) -> Any:
    """Run a SELECT returning JSON (as the only column of the only row).
    Returns parsed JSON or None on any failure."""
    try:
        proc = subprocess.run(
            ["psql", "-U", DB_USER, "-d", DB_NAME, "-tAc", sql],
            capture_output=True,
            text=True,
            timeout=PSQL_TIMEOUT_SECONDS,
        )
    except (subprocess.SubprocessError, OSError) as e:
        log.warning("psql_json error: %s", e)
        return None
    if proc.returncode != 0:
        return None
    out = proc.stdout.strip()
    if not out:
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return None


# --- Token + upstream call --------------------------------------------------

def _read_engine_state() -> Optional[Dict[str, Any]]:
    """Load /var/lib/stackpi/state.json. Returns None if missing or
    unreadable. Never raises."""
    try:
        with open(ENGINE_STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        log.warning("could not read engine state file: %s", e)
        return None


def _get_access_token() -> Tuple[Optional[str], Optional[str]]:
    """Return (access_token, api_base_url). api_base falls back to the
    DEFAULT_API_BASE constant if the engine state doesn't include one."""
    state = _read_engine_state()
    if not state:
        return None, DEFAULT_API_BASE
    token = state.get("access_token")
    base = state.get("api_base_url") or DEFAULT_API_BASE
    return token, base


def _fetch_endpoint(path: str) -> Dict[str, Any]:
    """Call one upstream endpoint and return its parsed JSON. Raises
    RuntimeError on any failure with a short, persistable message. The
    error message embeds the endpoint path so a partial failure across
    multiple endpoints is debuggable from the cloud_sync_meta sidecar."""
    token, base = _get_access_token()
    if not token:
        raise RuntimeError(
            "no access token in engine state — Pi may not be registered yet"
        )
    url = f"{base.rstrip('/')}{path}"
    try:
        resp = requests.get(
            url,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
            },
            timeout=UPSTREAM_TIMEOUT_SEC,
        )
    except requests.RequestException as e:
        raise RuntimeError(
            f"{path}: upstream transport error: {type(e).__name__}: {e}"
        )

    if resp.status_code == 401:
        # Don't refresh from here — the engine's heartbeat loop owns token
        # rotation. Just surface the situation; next sync will likely work.
        raise RuntimeError(
            f"{path}: upstream HTTP 401 (token expired/revoked): {resp.text[:200]}"
        )
    if resp.status_code != 200:
        raise RuntimeError(
            f"{path}: upstream HTTP {resp.status_code}: {resp.text[:200]}"
        )

    try:
        body = resp.json()
    except ValueError:
        raise RuntimeError(f"{path}: upstream returned non-JSON body: {resp.text[:200]}")
    if not isinstance(body, dict):
        raise RuntimeError(
            f"{path}: upstream body is not a JSON object: {type(body).__name__}"
        )
    # Confirmed 200 + JSON object: record a successful cloud contact for
    # /local/status connectivity. Best-effort — never break the sync path.
    from app.cloud_status import record_cloud_ok  # noqa: PLC0415
    record_cloud_ok()
    return body


# --- SQL bulk-replace -------------------------------------------------------

_MOVES_COLUMNS = (
    "id", "name", "scheduled_start", "real_start_time", "real_end_time",
    "asset_count", "status_id", "status_name", "status_color",
)
_EVENTS_COLUMNS = (
    "id", "name", "description", "event_type", "client",
    "scheduled_date", "location", "status_id", "status_name", "status_color",
    "created_at", "updated_at",
)
_PEOPLE_COLUMNS = (
    "id", "first_name", "last_name", "display_name", "rfid_tracker",
)
_MOVES_ASSETS_COLUMNS = (
    "id", "moves_id", "asset_id", "asset_serial_number", "priority_wave",
    "asset_name", "asset_rfid_tag", "asset_make", "asset_model",
)
_ASSET_TAGS_COLUMNS = ("id_hex", "serial", "name")


def _sql_literal(v: Any) -> str:
    """Format a Python value as a SQL literal suitable for inlining into
    a VALUES list. Strings get single-quoted with embedded quotes
    doubled; None becomes NULL; bools become true/false; integers/floats
    str()'d as-is.

    Important: empty strings are treated as NULL too. Upstream BaseCamp
    serializes missing values for some columns (including integer ones
    like priority_wave) as ""; passing those to Postgres breaks the
    integer cast. Treating "" as NULL universally is safe in our sync
    context because we never legitimately want to round-trip an empty
    string — the cloud_sync_* tables are all nullable and there's no
    semantic difference between "no value" and "empty value" for the
    fields we mirror."""
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v)
    if s == "":
        return "NULL"
    return "'" + s.replace("'", "''") + "'"


def _build_insert(table: str, columns: Tuple[str, ...],
                  rows: List[Dict[str, Any]]) -> Optional[str]:
    """Build a single INSERT ... VALUES (...), (...), ... statement.
    Returns None when rows is empty (caller skips the statement)."""
    if not rows:
        return None
    col_list = ", ".join(columns)
    values_chunks: List[str] = []
    for r in rows:
        vals = ", ".join(_sql_literal(r.get(c)) for c in columns)
        values_chunks.append(f"({vals})")
    values_sql = ", ".join(values_chunks)
    return f"INSERT INTO {table} ({col_list}) VALUES {values_sql};"


def _persist_payload(
    moves: List[Dict[str, Any]],
    events: List[Dict[str, Any]],
    people: List[Dict[str, Any]],
    moves_assets: List[Dict[str, Any]],
    asset_tags: List[Dict[str, Any]],
    fetched_at: str,
) -> None:
    """TRUNCATE + bulk-INSERT all sync targets in a single transaction.
    Updates the cloud_sync_meta sidecar with sync timestamps. Raises
    RuntimeError on DB failure — leaves the previous snapshot intact
    because the whole thing runs in BEGIN/COMMIT."""
    moves_insert        = _build_insert("cloud_sync_moves",        _MOVES_COLUMNS,        moves)
    events_insert       = _build_insert("cloud_sync_events",       _EVENTS_COLUMNS,       events)
    people_insert       = _build_insert("cloud_sync_people",       _PEOPLE_COLUMNS,       people)
    moves_assets_insert = _build_insert("cloud_sync_moves_assets", _MOVES_ASSETS_COLUMNS, moves_assets)
    asset_tags_insert   = _build_insert("local_asset_tags",        _ASSET_TAGS_COLUMNS,   asset_tags)

    script_parts = [
        "BEGIN;",
        "TRUNCATE TABLE cloud_sync_moves;",
        "TRUNCATE TABLE cloud_sync_events;",
        "TRUNCATE TABLE cloud_sync_people;",
        "TRUNCATE TABLE cloud_sync_moves_assets;",
        "TRUNCATE TABLE local_asset_tags;",
    ]
    if moves_insert:        script_parts.append(moves_insert)
    if asset_tags_insert:   script_parts.append(asset_tags_insert)
    if events_insert:       script_parts.append(events_insert)
    if people_insert:       script_parts.append(people_insert)
    if moves_assets_insert: script_parts.append(moves_assets_insert)

    # Meta — record both our local clock and the upstream-supplied one.
    script_parts.append(
        "INSERT INTO cloud_sync_meta (key, value, updated_at) "
        f"VALUES ('{META_KEY_LAST_SYNCED_AT}', NOW()::text, NOW()) "
        "ON CONFLICT (key) DO UPDATE "
        "SET value = EXCLUDED.value, updated_at = NOW();"
    )
    script_parts.append(
        "INSERT INTO cloud_sync_meta (key, value, updated_at) "
        f"VALUES ('{META_KEY_LAST_FETCHED_AT}', {_sql_literal(fetched_at)}, NOW()) "
        "ON CONFLICT (key) DO UPDATE "
        "SET value = EXCLUDED.value, updated_at = NOW();"
    )
    # Clear the last error on a successful sync.
    script_parts.append(
        "INSERT INTO cloud_sync_meta (key, value, updated_at) "
        f"VALUES ('{META_KEY_LAST_ERROR}', NULL, NOW()) "
        "ON CONFLICT (key) DO UPDATE "
        "SET value = NULL, updated_at = NOW();"
    )
    script_parts.append("COMMIT;")

    ok, err = _psql_exec_script("\n".join(script_parts))
    if not ok:
        # Surface the psql diagnostic so the operator (or the next sync
        # attempt's error banner) can see exactly which statement failed.
        raise RuntimeError(
            f"failed to persist cloud sync payload: {err[:500]}"
        )


def _record_error(message: str) -> None:
    """Persist last_error so the portal page can display why the latest
    sync failed without us throwing the message away."""
    payload = "'" + message[:1000].replace("'", "''") + "'"
    _psql_exec(
        "INSERT INTO cloud_sync_meta (key, value, updated_at) "
        f"VALUES ('{META_KEY_LAST_ERROR}', {payload}, NOW()) "
        "ON CONFLICT (key) DO UPDATE "
        "SET value = EXCLUDED.value, updated_at = NOW()"
    )


# --- Public API -------------------------------------------------------------

def sync_now() -> Dict[str, Any]:
    """Run one full sync cycle. Fetches all configured upstream endpoints
    sequentially; persists the combined result atomically; emits a single
    success or error system event with combined counts.

    Returns a result dict suitable for an API response:
      {"ok": True,  "moves_count": int, "events_count": int,
                    "people_count": int, "fetched_at": str}
      {"ok": False, "error": "<short>"}

    Never raises; failures are persisted to cloud_sync_meta(last_error)
    and surfaced via local_system_events."""
    # Local import avoids a startup cycle through app.main.
    from app import system_events  # noqa: PLC0415

    try:
        em_body = _fetch_endpoint(SYNC_ENDPOINT_EVENTS_MOVES)
        pp_body = _fetch_endpoint(SYNC_ENDPOINT_PEOPLE)
        ma_body = _fetch_endpoint(SYNC_ENDPOINT_MOVES_ASSETS)
        at_body = _fetch_endpoint(SYNC_ENDPOINT_ASSET_TAGS)
    except RuntimeError as e:
        msg = str(e)
        _record_error(msg)
        system_events.emit("sync", system_events.KIND_ERROR, "Sync Error", msg)
        return {"ok": False, "error": msg}

    moves        = em_body.get("moves")        or []
    events       = em_body.get("events")       or []
    people       = pp_body.get("people")       or []
    moves_assets = ma_body.get("moves_assets") or []
    asset_tags   = at_body.get("tags")         or []
    # Use whichever fetched_at the server emitted last — only used as a
    # debugging hint stored in cloud_sync_meta.
    fetched_at = (
        ma_body.get("fetched_at")
        or pp_body.get("fetched_at")
        or em_body.get("fetched_at")
        or ""
    )

    try:
        _persist_payload(moves, events, people, moves_assets, asset_tags, fetched_at)
    except RuntimeError as e:
        msg = str(e)
        _record_error(msg)
        system_events.emit("sync", system_events.KIND_ERROR, "Sync Error", msg)
        return {"ok": False, "error": msg}

    system_events.emit(
        "sync",
        system_events.KIND_SUCCESS,
        "Sync Success",
        f"{len(moves)} move(s), {len(events)} event(s), "
        f"{len(people)} person/people, {len(moves_assets)} asset(s), "
        f"{len(asset_tags)} asset tag(s)",
    )
    return {
        "ok": True,
        "moves_count":        len(moves),
        "events_count":       len(events),
        "people_count":       len(people),
        "moves_assets_count": len(moves_assets),
        "asset_tags_count":   len(asset_tags),
        "fetched_at":         fetched_at,
    }


def read_cached() -> Dict[str, Any]:
    """Read whatever is currently in cloud_sync_moves + cloud_sync_events
    + cloud_sync_people plus the meta sidecar. Used by
    GET /local/portal-data/cloud-sync."""
    moves = _psql_json(
        "SELECT COALESCE(jsonb_agg(r ORDER BY r.scheduled_start DESC NULLS LAST, r.id DESC), '[]'::jsonb) "
        "FROM (SELECT * FROM cloud_sync_moves) r"
    ) or []
    events = _psql_json(
        "SELECT COALESCE(jsonb_agg(r ORDER BY r.scheduled_date DESC NULLS LAST, r.id DESC), '[]'::jsonb) "
        "FROM (SELECT * FROM cloud_sync_events) r"
    ) or []
    people = _psql_json(
        "SELECT COALESCE(jsonb_agg(r ORDER BY COALESCE(r.display_name, r.last_name, r.first_name, '') ASC, r.id ASC), '[]'::jsonb) "
        "FROM (SELECT * FROM cloud_sync_people) r"
    ) or []
    moves_assets = _psql_json(
        "SELECT COALESCE(jsonb_agg(r ORDER BY r.moves_id ASC, r.priority_wave ASC NULLS LAST, r.id ASC), '[]'::jsonb) "
        "FROM (SELECT * FROM cloud_sync_moves_assets) r"
    ) or []
    meta_rows = _psql_json(
        "SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb) "
        "FROM cloud_sync_meta"
    ) or {}
    return {
        "moves":            moves,
        "events":           events,
        "people":           people,
        "moves_assets":     moves_assets,
        "last_synced_at":   meta_rows.get(META_KEY_LAST_SYNCED_AT),
        "last_fetched_at":  meta_rows.get(META_KEY_LAST_FETCHED_AT),
        "last_error":       meta_rows.get(META_KEY_LAST_ERROR),
    }


# --- CLI --------------------------------------------------------------------

def _cli_main(argv: List[str]) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s %(message)s",
    )
    result = sync_now()
    print(json.dumps(result, default=str, indent=2))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(_cli_main(sys.argv))
