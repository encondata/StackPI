"""Software-update endpoints for the Config → Update panel.

  GET  /local/update/status  — current vs latest git revision, whether an
                               update is available, and the live state + log
                               tail of any in-progress run.
  POST /local/update/start   — trigger the privileged updater, which runs
                               deploy.sh (git pull + rebuild + restart) inside
                               a transient systemd unit and reboots on success.

The heavy lifting lives in /usr/local/sbin/stackpi-update.sh (root, invoked via
a scoped NOPASSWD sudoers entry). This module only kicks it off and reports
progress by reading the state/log files the updater writes to /run/stackpi.

No auth — same LAN-trust posture as the rest of /local/*.
"""
import logging
import subprocess
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, HTTPException

log = logging.getLogger(__name__)

router = APIRouter(prefix="/local/update", tags=["update"])

# <repo>/api/app/update.py → parents[2] == <repo>. Works on the Pi
# (/home/csg/StackPI_v2) and in dev/CI without hardcoding a path.
REPO_DIR = Path(__file__).resolve().parents[2]

UPDATER = "/usr/local/sbin/stackpi-update.sh"
STATE_FILE = Path("/run/stackpi/update.state")
LOG_FILE = Path("/run/stackpi/update.log")

BRANCH = "main"
LOG_TAIL_LINES = 200

GIT_TIMEOUT_SEC = 10
FETCH_TIMEOUT_SEC = 20
START_TIMEOUT_SEC = 30


# ---------------------------------------------------------------------------
# Thin, monkeypatch-friendly shells around the side-effecting bits
# ---------------------------------------------------------------------------

def _git(args: List[str], timeout: int = GIT_TIMEOUT_SEC) -> str:
    """Run `git -C <repo> <args>` and return stripped stdout. Raises
    RuntimeError on non-zero exit or timeout."""
    try:
        proc = subprocess.run(
            ["git", "-C", str(REPO_DIR), *args],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"git {' '.join(args)} timed out")
    if proc.returncode != 0:
        raise RuntimeError(
            f"git {' '.join(args)} failed: {proc.stderr.strip() or proc.stdout.strip()}"
        )
    return proc.stdout.strip()


def _fetch() -> bool:
    """Best-effort `git fetch` of the tracked branch so the 'latest' SHA is
    fresh. Returns False (rather than raising) when offline — we then compare
    against the last-known origin ref."""
    try:
        _git(["fetch", "--quiet", "origin", BRANCH], timeout=FETCH_TIMEOUT_SEC)
        return True
    except RuntimeError as e:
        log.info("update fetch failed (offline?): %s", e)
        return False


def _run_state() -> str:
    """Current updater run state: idle | running | success | failed."""
    try:
        s = STATE_FILE.read_text(encoding="utf-8").strip()
        return s or "idle"
    except OSError:
        return "idle"


def _log_tail(lines: int = LOG_TAIL_LINES) -> str:
    try:
        text = LOG_FILE.read_text(encoding="utf-8")
    except OSError:
        return ""
    return "\n".join(text.splitlines()[-lines:])


def _trigger_update() -> None:
    """Invoke the privileged updater's `start` mode. Returns immediately —
    the updater detaches into its own systemd unit. Raises RuntimeError on
    any failure to launch."""
    try:
        proc = subprocess.run(
            ["sudo", "-n", UPDATER, "start"],
            capture_output=True,
            text=True,
            timeout=START_TIMEOUT_SEC,
            check=True,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError("updater did not start within timeout")
    except subprocess.CalledProcessError as e:
        raise RuntimeError(
            f"updater exited {e.returncode}: {(e.stderr or '').strip()}"
        )
    log.info("update trigger: %s", proc.stdout.strip())


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/status")
def update_status() -> dict:
    """Report the installed revision, the latest available on the tracked
    branch, and any in-progress run."""
    try:
        current = _git(["rev-parse", "HEAD"])
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

    fetch_ok = _fetch()

    latest: Optional[str] = None
    behind = 0
    try:
        latest = _git(["rev-parse", f"origin/{BRANCH}"])
        behind = int(_git(["rev-list", "--count", f"HEAD..origin/{BRANCH}"]))
    except (RuntimeError, ValueError) as e:
        # No upstream ref yet (never fetched) — treat as "unknown latest".
        log.info("update latest-ref lookup failed: %s", e)

    return {
        "branch": BRANCH,
        "current": current,
        "current_short": current[:7],
        "latest": latest,
        "latest_short": latest[:7] if latest else None,
        "behind": behind,
        "update_available": behind > 0,
        "fetch_ok": fetch_ok,
        "state": _run_state(),
        "log_tail": _log_tail(),
    }


@router.post("/start")
def update_start() -> dict:
    """Kick off an update. Idempotent while one is already running."""
    if _run_state() == "running":
        return {"ok": True, "started": False, "already_running": True, "state": "running"}
    try:
        _trigger_update()
    except RuntimeError as e:
        log.exception("update start failed")
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True, "started": True, "state": "running"}
