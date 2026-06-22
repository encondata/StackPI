"""StackPI registration + heartbeat agent.

Behaviour mirrors BaseCampV2/scripts/test_stackpi_registration.py but as
a long-running daemon that persists everything through app/state.py.

State machine (loops forever):

    +-- not registered --+
    |                    v
    | _request_init  -> /register/init
    |   ok -> persist {device_uuid, pairing_token, status=pre_registered}
    |   409 (already registered server-side) -> log + back off
    |
    | _poll_until_registered -> /register/poll every poll_interval
    |   ok+pre_registered -> keep polling
    |   ok+registered -> persist tokens, status=registered -> exit to heartbeat
    |   410/404 -> back to init
    |
    +-- registered ------+
        |                v
        | _send_heartbeat every heartbeat_interval
        |   200 -> sleep
        |   401 -> _refresh_access
        |          ok -> resume
        |          fail -> mark revoked, restart pairing flow
        |   other -> log + sleep
"""
import logging
import socket
import subprocess
import time
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Optional

import requests

from app import state as state_mod
from app.config import Settings
from app.hardware import get_hardware_serial

log = logging.getLogger(__name__)

_USER_AGENT = "stackpi-engine/0.1.0"
_VERSION_FALLBACK = "engine-0.1.0"


@lru_cache(maxsize=1)
def _code_version() -> str:
    """The git revision the running code is at — e.g. 'main@4cf914d' (with
    '-dirty' appended if tracked files have uncommitted changes). Cached: a
    redeploy restarts this process, so the running commit is fixed for its life.
    Falls back to the package version string if git isn't available."""
    repo = str(Path(__file__).resolve().parents[2])  # engine/app/agent.py → repo root

    def git(*args: str) -> subprocess.CompletedProcess:
        return subprocess.run(["git", "-C", repo, *args],
                              capture_output=True, text=True, timeout=5)

    try:
        sha = git("rev-parse", "--short", "HEAD")
        if sha.returncode != 0 or not sha.stdout.strip():
            return _VERSION_FALLBACK
        ver = sha.stdout.strip()
        branch = git("rev-parse", "--abbrev-ref", "HEAD")
        name = branch.stdout.strip()
        if branch.returncode == 0 and name and name != "HEAD":
            ver = f"{name}@{ver}"
        # '-dirty' only for uncommitted changes to TRACKED files (ignore the
        # untracked build artifacts a deployed checkout accumulates).
        if git("diff", "--quiet", "HEAD").returncode == 1:
            ver += "-dirty"
        return ver
    except (subprocess.SubprocessError, OSError):
        return _VERSION_FALLBACK

HEARTBEAT_FAILURE_THRESHOLD = 3


def _connectivity_after(code, failures: int):
    """Decide online state from a heartbeat result + prior consecutive-failure
    count. 200 -> online, reset. Network error (code None) or server error
    (any non-200/non-401) -> accumulate; flip offline at the threshold so a
    single blip doesn't flap. Returns (online: bool, new_failures: int)."""
    if code == 200:
        return True, 0
    failures += 1
    return (failures < HEARTBEAT_FAILURE_THRESHOLD), failures


def _fetch_interval(settings) -> int:
    """Operator-configured status interval from the local API; falls back to
    the env default if the API is unreachable or returns junk."""
    try:
        resp = requests.get(
            f"{settings.local_api_base.rstrip('/')}/local/settings/device-status",
            timeout=3,
        )
        if resp.status_code == 200:
            v = int(resp.json().get("interval_seconds"))
            if 10 <= v <= 300:
                return v
    except (requests.RequestException, ValueError, TypeError):
        pass
    return settings.heartbeat_interval_seconds


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _absolute_link_url(raw: Optional[str], base: str) -> Optional[str]:
    """Return an absolute URL. Pass-through if already absolute. Prefix
    with `base` if relative. Returns None if there's nothing to build on."""
    if not raw:
        return raw
    if raw.startswith(("http://", "https://")):
        return raw
    if not base:
        return raw
    return f"{base.rstrip('/')}{raw if raw.startswith('/') else '/' + raw}"



def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _default_device_name(settings: Settings) -> str:
    if settings.device_name:
        return settings.device_name
    return socket.gethostname() or "stackpi"


def _best_local_ip() -> str:
    """LAN IP via the UDP-connect trick. No packet is actually sent."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
        finally:
            s.close()
    except OSError:
        return "127.0.0.1"


def _post(
    settings: Settings,
    path: str,
    body: Optional[dict] = None,
    token: Optional[str] = None,
) -> requests.Response:
    url = f"{settings.api_base_url.rstrip('/')}{path}"
    headers = {"Content-Type": "application/json", "User-Agent": _USER_AGENT}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return requests.post(
        url, json=body or {}, headers=headers, timeout=settings.http_timeout_seconds
    )


def _update_state(settings: Settings, **changes) -> dict:
    """Read-modify-write a partial update to the state file."""
    current = state_mod.read_state(settings.state_file)
    current.update(changes)
    current["updated_at"] = _now_iso()
    state_mod.write_state(settings.state_file, current)
    return current


# ---------------------------------------------------------------------------
# pairing flow
# ---------------------------------------------------------------------------

def _request_init(settings: Settings) -> bool:
    """POST /stackpi/register/init. Persists the pairing token on success.
    Returns True on 200, False otherwise."""
    current = state_mod.read_state(settings.state_file)
    serial = current.get("hardware_serial") or get_hardware_serial()

    body: dict = {}
    if current.get("device_uuid"):
        body["device_uuid"] = current["device_uuid"]
    if serial:
        body["hardware_serial"] = serial
    if not current.get("name"):
        body["name"] = _default_device_name(settings)

    try:
        resp = _post(settings, "/stackpi/register/init", body)
    except requests.RequestException as e:
        log.warning("register/init network error: %s", e)
        return False

    if resp.status_code == 200:
        data = resp.json()
        log.info(
            "Pre-registered. token=%s expires_at=%s device_uuid=%s",
            data["pairing_token"],
            data["pairing_token_expires_at"],
            data["device_uuid"],
        )
        link_url = _absolute_link_url(data["link_url"], settings.pairing_link_base)
        _update_state(
            settings,
            device_uuid=data["device_uuid"],
            hardware_serial=serial,
            name=data["name"],
            status="pre_registered",
            pairing_token=data["pairing_token"],
            pairing_token_expires_at=data["pairing_token_expires_at"],
            link_url=link_url,
            # Always clear stale secrets on a fresh pairing cycle.
            access_token=None,
            access_token_expires_at=None,
            refresh_token=None,
            refresh_token_expires_at=None,
        )
        return True

    if resp.status_code == 409:
        # New server contract reclaims registered rows when device_uuid +
        # hardware_serial both match. Hitting 409 here implies the server
        # has a row for this device_uuid whose hardware_serial doesn't
        # match ours — either a UUID collision or this Pi is genuinely the
        # wrong device claiming someone else's identity. Backoff anyway.
        log.error("register/init → 409 (hardware_serial mismatch?): %s", resp.text[:200])
        return False

    log.warning("register/init → %s: %s", resp.status_code, resp.text[:200])
    return False


def _poll_until_registered(settings: Settings) -> bool:
    """Poll /stackpi/register/poll until status flips to registered.
    Returns True on success, False if we should restart the init flow."""
    current = state_mod.read_state(settings.state_file)
    device_uuid = current.get("device_uuid")
    if not device_uuid:
        log.warning("poll skipped: no device_uuid in state")
        return False

    attempt = 0
    while True:
        attempt += 1
        try:
            resp = _post(
                settings, "/stackpi/register/poll", {"device_uuid": device_uuid}
            )
        except requests.RequestException as e:
            log.warning("register/poll #%d network error: %s", attempt, e)
            time.sleep(settings.pairing_poll_interval_seconds)
            continue

        if resp.status_code == 200:
            data = resp.json()
            status = data.get("status")
            if status == "pre_registered":
                if attempt == 1 or attempt % 12 == 0:  # every ~minute at 5s cadence
                    log.info("poll #%d → pre_registered (waiting for pairing)", attempt)
                time.sleep(settings.pairing_poll_interval_seconds)
                continue
            if status == "registered":
                log.info("poll #%d → REGISTERED. Tokens received.", attempt)
                _update_state(
                    settings,
                    status="registered",
                    name=data.get("name", current.get("name")),
                    pairing_token=None,
                    pairing_token_expires_at=None,
                    link_url=None,
                    access_token=data["access_token"],
                    access_token_expires_at=data["access_token_expires_at"],
                    refresh_token=data["refresh_token"],
                    refresh_token_expires_at=data["refresh_token_expires_at"],
                    config=data.get("config", {}),
                    last_seen_at=_now_iso(),
                )
                return True
            log.warning("poll #%d → unknown status %s", attempt, status)
            time.sleep(settings.pairing_poll_interval_seconds)
            continue

        if resp.status_code == 410:
            log.error("poll #%d → 410: %s. Re-pairing.", attempt, resp.text[:200])
            return False
        if resp.status_code == 404:
            log.error("poll #%d → 404: server forgot us. Forcing re-init.", attempt)
            _update_state(settings, device_uuid=None, status=None)
            return False

        log.warning("poll #%d → %s: %s", attempt, resp.status_code, resp.text[:200])
        time.sleep(settings.pairing_poll_interval_seconds)


# ---------------------------------------------------------------------------
# steady-state
# ---------------------------------------------------------------------------

def _send_heartbeat(settings: Settings) -> tuple[Optional[int], Optional[str]]:
    """Send one heartbeat. Returns (status_code, reason). status_code is
    None on network error. reason is the structured 401 reason code from
    the server (`token_expired`, `device_revoked`, etc.) or None for
    success and non-401 responses."""
    current = state_mod.read_state(settings.state_file)
    access = current.get("access_token")
    if not access:
        return None, None

    body = {
        "metadata": {
            "ip": _best_local_ip(),
            "hostname": socket.gethostname(),
            "version": _code_version(),
        }
    }
    try:
        resp = _post(settings, "/stackpi/heartbeat", body, token=access)
    except requests.RequestException as e:
        log.warning("heartbeat network error: %s", e)
        return None, None

    if resp.status_code == 200:
        data = resp.json()
        _update_state(
            settings,
            name=data.get("name", current.get("name")),
            status=data.get("status", current.get("status")),
            config=data.get("config", current.get("config") or {}),
            last_seen_at=_now_iso(),
            online=True,
            heartbeat_ok_at=_now_iso(),
        )
        return 200, None

    reason = _parse_reason(resp) if resp.status_code == 401 else None
    return resp.status_code, reason


def _refresh_access(settings: Settings) -> bool:
    """Exchange the refresh token for a fresh access (and refresh) token.

    Server contract: /stackpi/auth/refresh returns a new access_token AND a
    new refresh_token (rolling refresh — both old JTIs are revoked). We
    persist both. For older servers that only return access_token, the
    refresh_token fields fall through to .get() and the existing refresh
    stays in place."""
    current = state_mod.read_state(settings.state_file)
    refresh = current.get("refresh_token")
    if not refresh:
        return False
    try:
        resp = _post(settings, "/stackpi/auth/refresh", token=refresh)
    except requests.RequestException as e:
        log.warning("auth/refresh network error: %s", e)
        return False
    if resp.status_code == 200:
        data = resp.json()
        changes = {
            "access_token": data["access_token"],
            "access_token_expires_at": data["access_token_expires_at"],
        }
        # Rolling refresh: if server returned a new refresh_token, persist it.
        # Old server (pre-rolling-refresh) omits these fields — keep current.
        if data.get("refresh_token"):
            changes["refresh_token"] = data["refresh_token"]
            changes["refresh_token_expires_at"] = data["refresh_token_expires_at"]
        _update_state(settings, **changes)
        return True
    log.warning("auth/refresh → %s: %s", resp.status_code, resp.text[:200])
    return False


def _parse_reason(resp: requests.Response) -> Optional[str]:
    """Pull the structured 401 reason from a response. Returns None for
    plain-text errors (old servers) or non-401 responses."""
    try:
        body = resp.json()
    except (ValueError, requests.JSONDecodeError):
        return None
    detail = body.get("detail") if isinstance(body, dict) else None
    if isinstance(detail, dict):
        return detail.get("reason")
    return None


def _ttl_fraction_remaining(expires_iso: Optional[str]) -> float:
    """Return remaining lifetime as a fraction of an arbitrary baseline.
    Returns 0.0 if no expiry recorded; 1.0 means fully fresh. We compute
    against the present moment — the caller decides what threshold to use.
    """
    if not expires_iso:
        return 0.0
    try:
        exp = datetime.fromisoformat(expires_iso)
    except (ValueError, TypeError):
        return 0.0
    if exp.tzinfo is None:
        exp = exp.replace(tzinfo=timezone.utc)
    remaining = (exp - datetime.now(timezone.utc)).total_seconds()
    return max(0.0, remaining)


def _proactive_refresh(settings: Settings) -> None:
    """Refresh well before tokens expire, so a transient outage during the
    last-minute refresh window can't strand us.

    Trigger when access_token has <50% of its 1h TTL remaining, OR refresh
    has <50% of its TTL remaining (rolling refresh resets the refresh clock
    too, so calling /auth/refresh is enough to bump both)."""
    current = state_mod.read_state(settings.state_file)
    access_remaining = _ttl_fraction_remaining(current.get("access_token_expires_at"))
    refresh_remaining = _ttl_fraction_remaining(current.get("refresh_token_expires_at"))

    # Thresholds are 50% of nominal TTLs (1h access, 96h refresh on the
    # server). Hardcoded fractions rather than DBs to keep the engine
    # independent of server config.
    access_due = access_remaining < (60 * 60 / 2)
    refresh_due = refresh_remaining < (96 * 60 * 60 / 2)
    if not access_due and not refresh_due:
        return
    log.info(
        "Proactive refresh: access remaining=%ds refresh remaining=%ds",
        int(access_remaining), int(refresh_remaining),
    )
    _refresh_access(settings)


def _mark_revoked(settings: Settings) -> None:
    """Clear secrets but keep identity so we can re-pair the same DB row."""
    _update_state(
        settings,
        status="revoked",
        access_token=None,
        access_token_expires_at=None,
        refresh_token=None,
        refresh_token_expires_at=None,
        pairing_token=None,
        pairing_token_expires_at=None,
        link_url=None,
    )


# ---------------------------------------------------------------------------
# main loop
# ---------------------------------------------------------------------------

_INIT_BACKOFF_SCHEDULE_SEC = (30, 60, 120, 300, 900)  # 30s → 60s → 2m → 5m → 15m cap


def _init_backoff_seconds(attempt: int) -> int:
    """Backoff schedule for repeated /register/init failures. Caps at 15
    minutes so a misbehaving server (e.g. 429 IP blacklist) can't trap us
    in a tight loop that compounds the problem."""
    idx = min(attempt, len(_INIT_BACKOFF_SCHEDULE_SEC) - 1)
    return _INIT_BACKOFF_SCHEDULE_SEC[idx]


def run_agent(settings: Settings) -> None:
    """Outer loop: keep pairing/re-pairing as needed; once registered,
    heartbeat until told otherwise."""
    init_failures = 0
    while True:
        current = state_mod.read_state(settings.state_file)
        is_registered = (
            current.get("status") == "registered"
            and current.get("access_token")
            and current.get("refresh_token")
        )

        if not is_registered:
            log.info("Not registered (status=%s) — starting pairing flow.", current.get("status"))
            if not _request_init(settings):
                backoff = _init_backoff_seconds(init_failures)
                init_failures += 1
                log.info("register/init failed; backing off %ds (attempt #%d)",
                         backoff, init_failures)
                time.sleep(backoff)
                continue
            init_failures = 0
            if not _poll_until_registered(settings):
                continue  # back to init
            init_failures = 0

        log.info(
            "Registered. Heartbeating every %ss.", settings.heartbeat_interval_seconds
        )
        failures = 0
        while True:
            interval = _fetch_interval(settings)
            # Re-read state so externally-driven changes (API clearing tokens
            # via /local/reset-pairing or /local/deregister) take effect within
            # one heartbeat interval without needing to restart the engine.
            current = state_mod.read_state(settings.state_file)
            if (
                current.get("status") != "registered"
                or not current.get("access_token")
            ):
                log.info(
                    "State changed externally (status=%s, has_token=%s) — "
                    "exiting heartbeat loop to re-pair.",
                    current.get("status"),
                    bool(current.get("access_token")),
                )
                break

            # Bump tokens before they get close to expiry so a transient
            # outage during the last-minute refresh window can't strand us.
            _proactive_refresh(settings)

            code, reason = _send_heartbeat(settings)
            if code == 401:
                # device_revoked = admin actually deregistered → re-pair (the
                # new server contract makes /register/init succeed, but log
                # the cause so it's auditable). Anything else is recoverable
                # via refresh first, then init as fallback.
                #
                # A 401 means the cloud responded, so it is NOT a connectivity
                # failure — leave failure accounting alone.
                if reason == "device_revoked":
                    log.warning("Heartbeat → 401 device_revoked. Admin deregistered; re-pairing.")
                    _mark_revoked(settings)
                    break
                log.info("Heartbeat → 401 (%s). Attempting refresh.", reason or "no-reason")
                if _refresh_access(settings):
                    continue
                log.warning("Refresh rejected — falling back to re-pair.")
                _mark_revoked(settings)
                break  # outer loop re-pairs

            # Non-401: do connectivity accounting. 200 already wrote
            # online=True in _send_heartbeat. On failures, only persist the
            # offline flag once the 3-strike threshold trips (or while still
            # tripped) to avoid redundant writes on every blip.
            online, failures = _connectivity_after(code, failures)
            if code == 200:
                time.sleep(interval)
                continue
            if code is None:
                log.warning("Heartbeat network error (failure #%d).", failures)
            else:
                log.warning("Heartbeat → unexpected %s (failure #%d).", code, failures)
            if not online:
                _update_state(
                    settings,
                    online=False,
                    last_error=f"heartbeat failed (code={code})",
                )
            time.sleep(interval)
            continue
