"""Local stackpi PostgreSQL status endpoints.

Shells out to `psql` (system-installed) over the Unix socket. The postgres
cluster has trust auth for local connections, so no password is needed.
"""
import logging
import re
import subprocess
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/local/db", tags=["local-db"])
log = logging.getLogger(__name__)

DB_NAME = "stackpi"
DB_USER = "csg"
DB_HOST = "localhost"
DB_PORT = 5432
PSQL_TIMEOUT_SECONDS = 5

# TEMPORARY destructive-action gate. This is the password the operator must
# type into the portal modal before we'll TRUNCATE the raw scan table.
# Replace with a proper auth/RBAC check once that subsystem exists. Keeping
# the value here (not in env / DB) so it's easy to find and tighten later.
MAINTENANCE_PASSWORD = "admin"


def _psql_scalar(sql: str) -> Optional[str]:
    """Run a single-row, single-column query and return the scalar as a
    stripped string. Returns None on any failure."""
    try:
        proc = subprocess.run(
            ["psql", "-U", DB_USER, "-d", DB_NAME, "-tAc", sql],
            capture_output=True,
            text=True,
            timeout=PSQL_TIMEOUT_SECONDS,
        )
    except (subprocess.SubprocessError, OSError) as e:
        log.warning("psql invocation error for %r: %s", sql, e)
        return None
    if proc.returncode != 0:
        log.warning("psql %r exit=%d stderr=%s", sql, proc.returncode, proc.stderr.strip())
        return None
    return proc.stdout.strip() or None


def _short_version(raw: Optional[str]) -> Optional[str]:
    """Extract just `<major>.<minor>` from `PostgreSQL 17.10 (Debian ...)`."""
    if not raw:
        return None
    m = re.search(r"PostgreSQL\s+(\d+(?:\.\d+)*)", raw)
    return m.group(1) if m else raw[:40]


@router.get("/status")
def db_status() -> Dict[str, Any]:
    """Return liveness + a few connection/size metrics for the stackpi DB."""
    version_raw = _psql_scalar("SELECT version()")
    if not version_raw:
        return {
            "status": "offline",
            "host": DB_HOST,
            "port": DB_PORT,
            "database": DB_NAME,
            "user": DB_USER,
        }

    size_raw = _psql_scalar(f"SELECT pg_database_size('{DB_NAME}')")
    active_raw = _psql_scalar(
        f"SELECT count(*) FROM pg_stat_activity WHERE datname='{DB_NAME}'"
    )
    max_raw = _psql_scalar("SHOW max_connections")

    def _int(v: Optional[str]) -> Optional[int]:
        try:
            return int(v) if v is not None else None
        except ValueError:
            return None

    return {
        "status": "online",
        "version": _short_version(version_raw),
        "host": DB_HOST,
        "port": DB_PORT,
        "database": DB_NAME,
        "user": DB_USER,
        "size_bytes": _int(size_raw),
        "active_connections": _int(active_raw),
        "max_connections": _int(max_raw),
    }


# ---------------------------------------------------------------------------
# Maintenance: clear local_rfid_raw_scans
# ---------------------------------------------------------------------------

class ClearRawScansRequest(BaseModel):
    """Body for POST /local/db/clear-rfid-raw-scans. Password is checked
    against MAINTENANCE_PASSWORD on the server — UI can't bypass."""
    password: str = Field(min_length=1, max_length=128)


def _psql_exec(sql: str) -> bool:
    """Run a write SQL statement. Returns True on success."""
    try:
        proc = subprocess.run(
            ["psql", "-U", DB_USER, "-d", DB_NAME, "-v", "ON_ERROR_STOP=1", "-c", sql],
            capture_output=True,
            text=True,
            timeout=PSQL_TIMEOUT_SECONDS,
        )
    except (subprocess.SubprocessError, OSError) as e:
        log.warning("psql exec error for %r: %s", sql, e)
        return False
    if proc.returncode != 0:
        log.warning("psql exec %r exit=%d stderr=%s", sql, proc.returncode, proc.stderr.strip())
        return False
    return True


@router.post("/clear-rfid-raw-scans")
def clear_rfid_raw_scans(body: ClearRawScansRequest) -> Dict[str, Any]:
    """Erase the local RFID scan pipeline. Gated by MAINTENANCE_PASSWORD.

    Wipes all three pipeline tables at once because they're FK-linked
    (local_rfid_matches.scan_id REFERENCES local_rfid_raw_scans(id)):
      * local_rfid_raw_scans         — every read from every reader
      * local_rfid_matches           — resolved hits
      * local_rfid_processed_scans   — upload queue (incl. any 'pending')

    Single TRUNCATE … RESTART IDENTITY across all three so Postgres can
    validate the FK in one shot, and BIGSERIALs reset together.

    NOTE: 'pending' rows in local_rfid_processed_scans that have not yet
    been uploaded to BaseCamp are LOST by this operation — the count is
    returned in `pending_lost` so the UI can warn after the fact."""
    if body.password != MAINTENANCE_PASSWORD:
        raise HTTPException(status_code=401, detail="Incorrect password")

    def _int(v: Optional[str]) -> int:
        try:
            return int(v) if v is not None else 0
        except ValueError:
            return 0

    raw_before        = _int(_psql_scalar("SELECT count(*) FROM local_rfid_raw_scans"))
    matches_before    = _int(_psql_scalar("SELECT count(*) FROM local_rfid_matches"))
    processed_before  = _int(_psql_scalar("SELECT count(*) FROM local_rfid_processed_scans"))
    pending_lost      = _int(_psql_scalar(
        "SELECT count(*) FROM local_rfid_processed_scans "
        "WHERE sync_validated IN ('pending','sent','failed')"
    ))

    if not _psql_exec(
        "TRUNCATE TABLE local_rfid_raw_scans, "
        "local_rfid_matches, "
        "local_rfid_processed_scans "
        "RESTART IDENTITY"
    ):
        raise HTTPException(
            status_code=500, detail="Failed to truncate RFID pipeline tables"
        )

    log.info(
        "Cleared RFID pipeline: raw=%d matches=%d processed=%d (un-uploaded lost=%d)",
        raw_before, matches_before, processed_before, pending_lost,
    )
    return {
        "ok": True,
        # rows_deleted kept for backward-compat with any UI still expecting it.
        "rows_deleted":            raw_before,
        "raw_scans_deleted":       raw_before,
        "matches_deleted":         matches_before,
        "processed_deleted":       processed_before,
        "pending_lost":            pending_lost,
    }
