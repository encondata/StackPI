"""Single-script uploader for matched RFID scans → BaseCamp scans_raw.

ONE place that knows how to:
  1. Read the StackPI access token out of the engine's state.json (kept
     fresh by stackpi-engine; we never write to that file).
  2. Drain local_rfid_processed_scans rows in 'pending' or 'failed' state
     by POSTing to /stackpi/scans/upload.
  3. Drive the per-row sync_validated state machine
     (pending → sent → acked|failed; failed retries on next tick).
  4. Adapt the batch size dynamically: drop to 1 on POST failure, escalate
     back to MAX_BATCH after N consecutive single-mode successes.

Callable two ways:
  * Library:  from app.scan_uploader import upload_tick
  * CLI:      python -m app.scan_uploader      # one tick, print result

Triggered by stackpi-scan-upload.timer (oneshot, ~30s cadence). Many ticks
per minute is fine — the SELECT … FOR UPDATE SKIP LOCKED clause makes
concurrent ticks safe.

Auth posture mirrors portal_sync: NEVER refreshes the access token from
here; the engine's heartbeat loop owns rotation. 401s are surfaced and
the next tick will work after the engine refreshes.

Dedup posture: we DON'T probe the upstream for duplicates. The Pi's
sync_validated state machine prevents normal re-sends; the rare ack-loss
duplicate is an accepted trade-off (see the BaseCamp endpoint comment for
the full rationale).
"""
import json
import logging
import subprocess
import sys
from typing import Any, Dict, List, Optional, Tuple

import requests

log = logging.getLogger(__name__)


# --- Config -----------------------------------------------------------------

ENGINE_STATE_FILE = "/var/lib/stackpi/state.json"
DEFAULT_API_BASE  = "https://api.serversherpa.com"
UPLOAD_ENDPOINT   = "/stackpi/scans/upload"

DB_NAME = "stackpi"
DB_USER = "csg"
PSQL_TIMEOUT_SECONDS = 10
UPSTREAM_TIMEOUT_SEC = 25.0

# Adaptive batch size. Starts at MAX_BATCH. On any POST failure (network
# error, 5xx, etc.) drops to 1. Single-mode counts consecutive successful
# POSTs (regardless of per-row result); SINGLE_SUCCESS_THRESHOLD bumps it
# back to MAX_BATCH and resets the streak.
MAX_BATCH                = 50
SINGLE_MODE_BATCH        = 1
SINGLE_SUCCESS_THRESHOLD = 20

# Janitor window: rows stuck in 'sent' longer than this are rolled back to
# 'pending' for retry on the next tick. Covers crash-mid-POST and
# request-timeout-but-server-completed cases. Server-side dedup is off, so
# rollback risks an ack-loss-style duplicate — accepted trade-off.
STUCK_SENT_MINUTES = 5

# local_app_settings keys for the adaptive state.
KEY_BATCH_SIZE    = "scan_upload_batch_size"
KEY_SINGLE_STREAK = "scan_upload_single_streak"


# --- DB helpers (subprocess psql, matches the rest of the codebase) ---------

def _psql_exec(sql: str) -> bool:
    try:
        proc = subprocess.run(
            ["psql", "-U", DB_USER, "-d", DB_NAME, "-v", "ON_ERROR_STOP=1", "-c", sql],
            capture_output=True, text=True, timeout=PSQL_TIMEOUT_SECONDS,
        )
    except (subprocess.SubprocessError, OSError) as e:
        log.warning("psql exec error: %s", e)
        return False
    if proc.returncode != 0:
        log.warning("psql exec exit=%d stderr=%s", proc.returncode, proc.stderr.strip())
        return False
    return True


def _psql_json(sql: str) -> Any:
    """Run a SELECT returning JSON in column 1 row 1. Returns parsed JSON or None."""
    try:
        proc = subprocess.run(
            ["psql", "-U", DB_USER, "-d", DB_NAME, "-tAc", sql],
            capture_output=True, text=True, timeout=PSQL_TIMEOUT_SECONDS,
        )
    except (subprocess.SubprocessError, OSError) as e:
        log.warning("psql_json error: %s", e)
        return None
    if proc.returncode != 0:
        log.warning("psql_json exit=%d stderr=%s", proc.returncode, proc.stderr.strip())
        return None
    out = proc.stdout.strip()
    if not out:
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return None


def _psql_scalar(sql: str) -> Optional[str]:
    """Return the first column of the first row, as a string. None on miss."""
    try:
        proc = subprocess.run(
            ["psql", "-U", DB_USER, "-d", DB_NAME, "-tAc", sql],
            capture_output=True, text=True, timeout=PSQL_TIMEOUT_SECONDS,
        )
    except (subprocess.SubprocessError, OSError):
        return None
    if proc.returncode != 0:
        return None
    out = proc.stdout.strip()
    return out or None


# --- Token + upstream call --------------------------------------------------

def _read_engine_state() -> Optional[Dict[str, Any]]:
    try:
        with open(ENGINE_STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        log.warning("could not read engine state file: %s", e)
        return None


def _get_access_token() -> Tuple[Optional[str], str]:
    state = _read_engine_state()
    if not state:
        return None, DEFAULT_API_BASE
    token = state.get("access_token")
    base  = state.get("api_base_url") or DEFAULT_API_BASE
    return token, base


# --- Adaptive batch size ----------------------------------------------------

def _get_batch_size() -> int:
    raw = _psql_scalar(
        f"SELECT value FROM local_app_settings WHERE key='{KEY_BATCH_SIZE}' LIMIT 1"
    )
    if raw is None:
        return MAX_BATCH
    try:
        v = int(raw)
        return max(1, min(MAX_BATCH, v))
    except ValueError:
        return MAX_BATCH


def _get_single_streak() -> int:
    raw = _psql_scalar(
        f"SELECT value FROM local_app_settings WHERE key='{KEY_SINGLE_STREAK}' LIMIT 1"
    )
    if raw is None:
        return 0
    try:
        return max(0, int(raw))
    except ValueError:
        return 0


def _set_setting_int(key: str, value: int) -> None:
    _psql_exec(
        "INSERT INTO local_app_settings (key, value) "
        f"VALUES ('{key}', '{int(value)}') "
        "ON CONFLICT (key) DO UPDATE "
        "SET value = EXCLUDED.value, updated_at = NOW()"
    )


def _on_post_failure() -> None:
    """POST itself failed (network, 5xx). Drop to single-mode and reset streak."""
    _set_setting_int(KEY_BATCH_SIZE, SINGLE_MODE_BATCH)
    _set_setting_int(KEY_SINGLE_STREAK, 0)


def _on_post_success(current_batch: int) -> None:
    """POST returned a 2xx. If we're in single-mode, count up; threshold
    bumps us back to MAX_BATCH. Otherwise no-op."""
    if current_batch >= MAX_BATCH:
        return
    streak = _get_single_streak() + 1
    if streak >= SINGLE_SUCCESS_THRESHOLD:
        _set_setting_int(KEY_BATCH_SIZE, MAX_BATCH)
        _set_setting_int(KEY_SINGLE_STREAK, 0)
    else:
        _set_setting_int(KEY_SINGLE_STREAK, streak)


# --- Row selection + state transitions --------------------------------------

# Pulls up to N rows from pending+failed, atomically flips them to 'sent',
# and returns the rows as JSON. FOR UPDATE SKIP LOCKED makes two concurrent
# ticks safe (each grabs a disjoint subset; neither blocks the other).
_PICK_AND_LOCK_SQL = """
WITH picked AS (
    SELECT id FROM local_rfid_processed_scans
    WHERE sync_validated IN ('pending','failed')
    ORDER BY id ASC
    LIMIT {limit}
    FOR UPDATE SKIP LOCKED
),
updated AS (
    UPDATE local_rfid_processed_scans p
    SET sync_validated = 'sent',
        sync_send_time = NOW()
    FROM picked
    WHERE p.id = picked.id
    RETURNING p.id, p.id_hex, p.event_timestamp,
              p.reader_name, p.match_type, p.match_data, p.raw_json
)
SELECT COALESCE(jsonb_agg(row_to_json(updated.*) ORDER BY (row_to_json(updated.*)->>'id')::bigint),
                '[]'::jsonb)
FROM updated;
"""


def _pick_and_lock(limit: int) -> List[Dict[str, Any]]:
    sql = _PICK_AND_LOCK_SQL.format(limit=int(limit))
    rows = _psql_json(sql) or []
    return rows if isinstance(rows, list) else []


def _mark_acked(client_record_ids: List[int]) -> None:
    if not client_record_ids:
        return
    ids = ",".join(str(int(i)) for i in client_record_ids)
    _psql_exec(
        f"UPDATE local_rfid_processed_scans "
        f"SET sync_validated='acked', sync_validate_time=NOW() "
        f"WHERE id IN ({ids})"
    )


def _mark_failed(client_record_ids: List[int]) -> None:
    if not client_record_ids:
        return
    ids = ",".join(str(int(i)) for i in client_record_ids)
    _psql_exec(
        f"UPDATE local_rfid_processed_scans "
        f"SET sync_validated='failed', sync_validate_time=NOW() "
        f"WHERE id IN ({ids})"
    )


def _rollback_to_pending(client_record_ids: List[int]) -> None:
    """Used when the POST itself failed (network/5xx). The rows we'd
    flipped to 'sent' get rolled back so the next tick picks them up."""
    if not client_record_ids:
        return
    ids = ",".join(str(int(i)) for i in client_record_ids)
    _psql_exec(
        f"UPDATE local_rfid_processed_scans "
        f"SET sync_validated='pending', sync_send_time=NULL "
        f"WHERE id IN ({ids}) AND sync_validated='sent'"
    )


def _janitor_sweep() -> int:
    """Roll back any row stuck in 'sent' longer than STUCK_SENT_MINUTES.
    Returns the row count touched (for logging)."""
    raw = _psql_scalar(
        f"WITH stuck AS ( "
        f"  UPDATE local_rfid_processed_scans "
        f"  SET sync_validated='pending', sync_send_time=NULL "
        f"  WHERE sync_validated='sent' "
        f"    AND sync_send_time < NOW() - INTERVAL '{STUCK_SENT_MINUTES} minutes' "
        f"  RETURNING 1 "
        f") SELECT count(*) FROM stuck"
    )
    try:
        return int(raw or 0)
    except ValueError:
        return 0


# --- HTTP -------------------------------------------------------------------

def _post_batch(rows: List[Dict[str, Any]]) -> Tuple[bool, List[Dict[str, Any]], str]:
    """POST a batch of rows to BaseCamp. Returns (ok, results, error_msg).
       ok=False on transport / non-2xx / parse errors."""
    token, base = _get_access_token()
    if not token:
        return False, [], "no access token in engine state — Pi not registered yet"
    url = f"{base.rstrip('/')}{UPLOAD_ENDPOINT}"

    payload = {
        "scans": [
            {
                "client_record_id": int(r["id"]),
                "id_hex":           r.get("id_hex") or "",
                "event_timestamp":  r.get("event_timestamp"),
                "reader_name":      r.get("reader_name"),
                "match_type":       r.get("match_type"),
                "match_data":       r.get("match_data"),
                "raw_payload":      r.get("raw_json"),
            }
            for r in rows
        ],
    }

    try:
        resp = requests.post(
            url,
            json=payload,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
            },
            timeout=UPSTREAM_TIMEOUT_SEC,
        )
    except requests.RequestException as e:
        return False, [], f"transport error: {type(e).__name__}: {e}"

    if resp.status_code != 200:
        return False, [], f"upstream HTTP {resp.status_code}: {resp.text[:200]}"

    try:
        body = resp.json()
    except ValueError:
        return False, [], f"upstream returned non-JSON body: {resp.text[:200]}"

    if not isinstance(body, dict) or "results" not in body:
        return False, [], f"upstream body missing 'results': {str(body)[:200]}"

    # Confirmed 200 + well-formed body: record a successful cloud contact for
    # /local/status connectivity. Best-effort — never break the upload path.
    from app.cloud_status import record_cloud_ok  # noqa: PLC0415
    record_cloud_ok()
    return True, body.get("results") or [], ""


# --- Public API -------------------------------------------------------------

def upload_tick() -> Dict[str, Any]:
    """Run one upload cycle. Picks up to current-batch-size pending/failed
    rows, POSTs them, applies per-row results, and updates the adaptive
    batch state. Never raises; failures bubble up via the returned dict."""
    from app import system_events  # noqa: PLC0415

    n_rolled_back = _janitor_sweep()
    if n_rolled_back > 0:
        log.info("janitor reset %d stuck 'sent' rows back to pending", n_rolled_back)

    batch_size = _get_batch_size()
    rows = _pick_and_lock(batch_size)
    if not rows:
        return {"ok": True, "uploaded": 0, "failed": 0, "rolled_back": n_rolled_back,
                "batch_size": batch_size, "idle": True}

    locked_ids = [int(r["id"]) for r in rows]

    ok, results, err = _post_batch(rows)
    if not ok:
        _rollback_to_pending(locked_ids)
        _on_post_failure()
        log.warning("scan upload POST failed: %s", err)
        # Don't spam system events for every transient blip; one per failure
        # is reasonable and matches the sync flow.
        system_events.emit(
            "scan_upload",
            system_events.KIND_ERROR,
            "Scan Upload Failed",
            err[:1000],
        )
        return {"ok": False, "error": err, "batch_size": batch_size,
                "rolled_back": n_rolled_back}

    # POST succeeded — interpret per-row results.
    acked: List[int] = []
    failed: List[Tuple[int, str]] = []
    seen: set = set()
    for r in results:
        if not isinstance(r, dict):
            continue
        try:
            cri = int(r.get("client_record_id"))
        except (TypeError, ValueError):
            continue
        seen.add(cri)
        status = r.get("status")
        if status == "acked":
            acked.append(cri)
        elif status == "failed":
            failed.append((cri, str(r.get("error") or "")[:200]))

    # Any locked row the server didn't report on (shouldn't happen, but be
    # defensive) goes back to pending so we don't strand it as 'sent'.
    missing = [i for i in locked_ids if i not in seen]
    if missing:
        _rollback_to_pending(missing)
        log.warning("server omitted %d row(s) from results — rolled back", len(missing))

    _mark_acked(acked)
    _mark_failed([i for i, _ in failed])

    _on_post_success(batch_size)

    if failed:
        # Emit one event summarizing failed rows so the operator notices
        # without us spamming per-row events.
        sample = ", ".join(f"#{i}: {msg or '<no error>'}" for i, msg in failed[:3])
        more = f" (+{len(failed) - 3} more)" if len(failed) > 3 else ""
        system_events.emit(
            "scan_upload",
            system_events.KIND_ERROR,
            f"Scan Upload Failed: {len(failed)} row(s)",
            f"{sample}{more}",
        )

    return {
        "ok": True,
        "uploaded":    len(acked),
        "failed":      len(failed),
        "rolled_back": n_rolled_back + len(missing),
        "batch_size":  batch_size,
        "idle":        False,
    }


# --- CLI --------------------------------------------------------------------

def _cli_main(argv: List[str]) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s %(message)s",
    )
    result = upload_tick()
    print(json.dumps(result, default=str, indent=2))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(_cli_main(sys.argv))
