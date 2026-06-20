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
import re
import subprocess
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

log = logging.getLogger(__name__)

router = APIRouter(prefix="/local/update", tags=["update"])

# <repo>/api/app/update.py → parents[2] == <repo>. Works on the Pi
# (/home/csg/StackPI_v2) and in dev/CI without hardcoding a path.
REPO_DIR = Path(__file__).resolve().parents[2]

UPDATER = "/usr/local/sbin/stackpi-update.sh"
UPDATE_UNIT = "stackpi-update.service"
STATE_FILE = Path("/run/stackpi/update.state")
LOG_FILE = Path("/run/stackpi/update.log")

DEFAULT_BRANCH = "main"
LOG_TAIL_LINES = 200
COMMITS_LIMIT_DEFAULT = 20
COMMITS_LIMIT_MAX = 100

# Branch names and commit refs reach `git checkout`/`reset` in the privileged
# updater, so reject anything with shell/ref metacharacters (allow only safe
# git-ref characters).
_REF_RE = re.compile(r"^[A-Za-z0-9._/-]{1,100}$")

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
    """Best-effort `git fetch` of all branches so the branch/commit lists and
    'latest' SHAs are fresh. Returns False (rather than raising) when offline —
    we then work from the last-known origin refs."""
    try:
        _git(["fetch", "--quiet", "--prune", "origin"], timeout=FETCH_TIMEOUT_SEC)
        return True
    except RuntimeError as e:
        log.info("update fetch failed (offline?): %s", e)
        return False


def _valid_ref(ref: str) -> bool:
    return bool(_REF_RE.match(ref))


def _current_branch() -> str:
    """The branch the device is on (detached HEAD → DEFAULT_BRANCH)."""
    try:
        b = _git(["rev-parse", "--abbrev-ref", "HEAD"])
        return b if b and b != "HEAD" else DEFAULT_BRANCH
    except RuntimeError:
        return DEFAULT_BRANCH


def _list_branches() -> List[str]:
    """Remote branch short names (origin/* minus the symbolic HEAD)."""
    try:
        out = _git(
            ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"]
        )
    except RuntimeError:
        return []
    names = []
    for line in out.splitlines():
        name = line.strip()
        if not name or name.endswith("/HEAD"):
            continue
        names.append(name[len("origin/"):] if name.startswith("origin/") else name)
    return sorted(set(names))


def _list_commits(branch: str, limit: int) -> List[dict]:
    """Recent commits on origin/<branch>, newest first. \\x1f-separated fields
    avoid clashing with anything in a commit subject."""
    try:
        out = _git(
            [
                "log",
                f"origin/{branch}",
                f"-n{int(limit)}",
                "--format=%H%x1f%h%x1f%cI%x1f%s",
            ]
        )
    except RuntimeError:
        return []
    commits = []
    for line in out.splitlines():
        parts = line.split("\x1f")
        if len(parts) == 4:
            commits.append(
                {"sha": parts[0], "short": parts[1], "date": parts[2], "subject": parts[3]}
            )
    return commits


def _run_state() -> str:
    """Raw updater run state from the state file: idle | running | success |
    failed. May be stale — see _effective_state."""
    try:
        s = STATE_FILE.read_text(encoding="utf-8").strip()
        return s or "idle"
    except OSError:
        return "idle"


def _unit_active() -> bool:
    """True iff the updater's transient systemd unit is currently active. This
    is the authoritative 'an update is in progress' signal: a stale 'running'
    state file (e.g. a unit that died at launch before recording a result) must
    NOT be trusted as a lock, or it would wedge the endpoint and UI forever."""
    try:
        return (
            subprocess.run(
                ["systemctl", "is-active", "--quiet", UPDATE_UNIT], timeout=5
            ).returncode
            == 0
        )
    except (subprocess.TimeoutExpired, OSError):
        return False


def _effective_state() -> str:
    """Run state reconciled against reality: a 'running' file with no live unit
    means the run died without recording a result — report it as 'failed' so
    the UI doesn't spin forever."""
    state = _run_state()
    if state == "running" and not _unit_active():
        return "failed"
    return state


def _log_tail(lines: int = LOG_TAIL_LINES) -> str:
    try:
        text = LOG_FILE.read_text(encoding="utf-8")
    except OSError:
        return ""
    return "\n".join(text.splitlines()[-lines:])


def _trigger_update(branch: Optional[str] = None, commit: Optional[str] = None) -> None:
    """Invoke the privileged updater's `start` mode, optionally targeting a
    specific branch (and commit on it). Returns immediately — the updater
    detaches into its own systemd unit. Raises RuntimeError on any failure to
    launch."""
    cmd = ["sudo", "-n", UPDATER, "start"]
    if branch:
        cmd.append(branch)
        if commit:
            cmd.append(commit)
    try:
        proc = subprocess.run(
            cmd,
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

@router.get("/branches")
def update_branches() -> dict:
    """All remote branches + the branch the device is currently on."""
    fetch_ok = _fetch()
    return {
        "current_branch": _current_branch(),
        "branches": _list_branches(),
        "fetch_ok": fetch_ok,
    }


@router.get("/commits")
def update_commits(
    branch: str = Query(..., max_length=100),
    limit: int = Query(COMMITS_LIMIT_DEFAULT, ge=1, le=COMMITS_LIMIT_MAX),
) -> dict:
    """Recent commits on origin/<branch>, newest first (the first is the tip)."""
    if not _valid_ref(branch):
        raise HTTPException(status_code=400, detail="invalid branch name")
    _fetch()
    return {"branch": branch, "commits": _list_commits(branch, limit)}


@router.get("/status")
def update_status(
    branch: Optional[str] = Query(None, max_length=100),
    commit: Optional[str] = Query(None, max_length=100),
) -> dict:
    """Report the installed revision vs. a target (branch tip, or a specific
    commit), and any in-progress run. With no params, the target is the current
    branch's tip — so the touchscreen panel keeps working unchanged."""
    if branch is not None and not _valid_ref(branch):
        raise HTTPException(status_code=400, detail="invalid branch name")
    if commit is not None and not _valid_ref(commit):
        raise HTTPException(status_code=400, detail="invalid commit")

    try:
        current = _git(["rev-parse", "HEAD"])
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    current_branch = _current_branch()
    branch = branch or current_branch

    fetch_ok = _fetch()

    target: Optional[str] = None
    behind = 0
    try:
        target = commit if commit else _git(["rev-parse", f"origin/{branch}"])
        # How far HEAD is behind the target (0 when the target is same/older).
        behind = int(_git(["rev-list", "--count", f"HEAD..{target}"]))
    except (RuntimeError, ValueError) as e:
        log.info("update target lookup failed: %s", e)

    return {
        "branch": branch,
        "current_branch": current_branch,
        "current": current,
        "current_short": current[:7],
        "target": target,
        "target_short": target[:7] if target else None,
        "latest_short": target[:7] if target else None,  # touchscreen-panel compat
        "behind": behind,
        "update_available": bool(target and target != current),
        "fetch_ok": fetch_ok,
        "state": _effective_state(),
        "log_tail": _log_tail(),
    }


class UpdateStartRequest(BaseModel):
    branch: Optional[str] = Field(default=None, max_length=100)
    commit: Optional[str] = Field(default=None, max_length=100)


@router.post("/start")
def update_start(body: Optional[UpdateStartRequest] = None) -> dict:
    """Kick off an update — optionally to a specific branch/commit. Idempotent
    while one is genuinely running (judged by the live systemd unit, so a stale
    state can't lock out retries). No body = update the current branch's tip."""
    branch = body.branch if body else None
    commit = body.commit if body else None
    if branch is not None and not _valid_ref(branch):
        raise HTTPException(status_code=400, detail="invalid branch name")
    if commit is not None and not _valid_ref(commit):
        raise HTTPException(status_code=400, detail="invalid commit")

    if _unit_active():
        return {"ok": True, "started": False, "already_running": True, "state": "running"}
    try:
        _trigger_update(branch, commit)
    except RuntimeError as e:
        log.exception("update start failed")
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True, "started": True, "state": "running"}
