"""System-level settings endpoints. Reads current state from `hostnamectl`
and `nmcli`; writes go through the privileged helper at
/usr/local/sbin/stackpi-settings-helper.sh (csg has NOPASSWD sudo for that
one path; the helper validates again before calling system tools).

No auth on these endpoints — the LAN itself is the trust boundary. Same
posture as the other /local/* endpoints.
"""
import ipaddress
import logging
import os
import re
import subprocess
import time
from enum import Enum
from typing import Any, Dict, List, Optional

import requests
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/local/settings", tags=["local-settings"])
log = logging.getLogger(__name__)

HELPER = "/usr/local/sbin/stackpi-settings-helper.sh"
SUDO = ["sudo", "-n", HELPER]

HOSTNAME_RE = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?$")
HOSTNAME_MAX = 63
SSID_MAX = 32
PASSWORD_MAX = 128

WAN_IP_URL = "https://api.ipify.org"
WAN_IP_TTL_SECONDS = 60
_WAN_CACHE: Dict[str, object] = {"ip": None, "ts": 0.0}
_IP_RE = re.compile(r"^[0-9a-fA-F:.]+$")


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class HostnameRequest(BaseModel):
    hostname: str = Field(min_length=1, max_length=HOSTNAME_MAX)


class WifiConnectRequest(BaseModel):
    ssid: str = Field(min_length=1, max_length=SSID_MAX)
    password: Optional[str] = Field(default=None, max_length=PASSWORD_MAX)
    hidden: bool = False


class WifiDisconnectRequest(BaseModel):
    ssid: str = Field(min_length=1, max_length=SSID_MAX)


class WiredStaticRequest(BaseModel):
    ip: str = Field(min_length=1, max_length=45)
    prefix: int = Field(ge=1, le=32)
    gateway: str = Field(min_length=1, max_length=45)
    dns: List[str] = Field(default_factory=list)


class WiredConfigRequest(BaseModel):
    method: str = Field(pattern="^(auto|manual)$")
    static: Optional[WiredStaticRequest] = None


# --- Hardware settings -----------------------------------------------------
# Values are stored in local_app_settings (key/value). Pydantic enums
# constrain the allowed set, so by the time a value reaches SQL it's known
# safe and injection-free.

class StackLight(str, Enum):
    THREE_COLOR = "3-color"
    FOUR_COLOR = "4-color"
    NOT_INSTALLED = "not_installed"


class AudioFeedback(str, Enum):
    ALL = "all"
    NONE = "none"
    ERROR_ONLY = "error_only"


class HardwareRequest(BaseModel):
    stacklight_enable: Optional[StackLight] = None
    audio_feedback: Optional[AudioFeedback] = None


# --- Time / NTP -----------------------------------------------------------

class TimezoneRequest(BaseModel):
    timezone: str = Field(min_length=1, max_length=60)


class NTPRequest(BaseModel):
    # Empty list / None = clear override, fall back to defaults.
    servers: Optional[List[str]] = None


class TimezoneAutoRequest(BaseModel):
    enabled: bool


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _run_helper(*args: str, timeout: int = 30) -> str:
    """Invoke the privileged helper. Raises HTTPException on failure."""
    try:
        proc = subprocess.run(
            [*SUDO, *args],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as e:
        log.error("helper timeout running %s: %s", args, e)
        raise HTTPException(status_code=504, detail="helper timed out")
    except (OSError, subprocess.SubprocessError) as e:
        log.error("helper invocation error %s: %s", args, e)
        raise HTTPException(status_code=500, detail=f"helper invocation error: {e}")
    if proc.returncode != 0:
        log.warning(
            "helper %s exit=%d stderr=%s", args, proc.returncode, proc.stderr.strip()
        )
        raise HTTPException(
            status_code=400, detail=proc.stderr.strip() or "helper failed"
        )
    return proc.stdout


def _split_nmcli(line: str) -> List[str]:
    """Split a `nmcli -t` line on colons while respecting backslash escapes."""
    parts: List[str] = []
    cur: List[str] = []
    i = 0
    while i < len(line):
        c = line[i]
        if c == "\\" and i + 1 < len(line):
            cur.append(line[i + 1])
            i += 2
        elif c == ":":
            parts.append("".join(cur))
            cur = []
            i += 1
        else:
            cur.append(c)
            i += 1
    parts.append("".join(cur))
    return parts


def _parse_connections(output: str) -> List[dict]:
    """Parse output of `nmcli -t -f NAME,TYPE,DEVICE,STATE connection show --active`."""
    conns: List[dict] = []
    for line in output.splitlines():
        if not line:
            continue
        parts = _split_nmcli(line)
        if len(parts) < 4:
            continue
        name, conn_type, device, state = parts[0], parts[1], parts[2], parts[3]
        conns.append(
            {
                "name": name,
                "type": conn_type,
                "device": device,
                "state": state,
            }
        )
    return conns


def _get_device_ips() -> Dict[str, str]:
    """Map device name → primary IPv4 address from `ip -4 -o addr show`.
    No sudo required. Skips devices with no IPv4 (e.g., a wifi adapter
    that's disabled)."""
    try:
        proc = subprocess.run(
            ["ip", "-4", "-o", "addr", "show"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (subprocess.SubprocessError, OSError) as e:
        log.warning("ip addr show failed: %s", e)
        return {}
    if proc.returncode != 0:
        return {}
    out: Dict[str, str] = {}
    for line in proc.stdout.splitlines():
        # Example: "2: eth0    inet 10.10.48.167/22 brd 10.10.51.255 scope global eth0"
        parts = line.split()
        if len(parts) >= 4 and parts[2] == "inet":
            out[parts[1]] = parts[3].split("/", 1)[0]
    return out


def _get_wan_ip() -> Optional[str]:
    """Return the device's public-facing IPv4, fetched from api.ipify.org.
    Cached for WAN_IP_TTL_SECONDS so we don't hammer the lookup endpoint
    on every settings refresh."""
    now = time.time()
    cached_ip = _WAN_CACHE.get("ip")
    cached_ts = float(_WAN_CACHE.get("ts") or 0)
    if cached_ip and now - cached_ts < WAN_IP_TTL_SECONDS:
        return str(cached_ip)
    try:
        resp = requests.get(WAN_IP_URL, timeout=4)
        if resp.status_code == 200:
            ip = resp.text.strip()
            if _IP_RE.match(ip):
                _WAN_CACHE["ip"] = ip
                _WAN_CACHE["ts"] = now
                return ip
    except requests.RequestException as e:
        log.warning("WAN IP fetch failed: %s", e)
    # Stale entry is better than nothing.
    return str(cached_ip) if cached_ip else None


# Hosts used to confirm real internet reachability (not just a local link).
_CONNECTIVITY_HOSTS = ("portal.serversherpa.com", "google.com")


def _default_gateway() -> Optional[str]:
    """Parse the default-route gateway from `ip route show default`."""
    try:
        proc = subprocess.run(
            ["ip", "route", "show", "default"],
            capture_output=True, text=True, timeout=5,
        )
    except (subprocess.SubprocessError, OSError):
        return None
    if proc.returncode != 0:
        return None
    # Example: "default via 10.10.48.1 dev eth0 proto dhcp ..."
    for line in proc.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 3 and parts[0] == "default" and parts[1] == "via":
            return parts[2]
    return None


def _ping(host: str, timeout_s: int = 2) -> bool:
    """Single ICMP echo. Returns True on reply. ping has cap_net_raw on the
    Pi, so no privilege/helper needed."""
    try:
        proc = subprocess.run(
            ["ping", "-c", "1", "-W", str(timeout_s), host],
            capture_output=True, text=True, timeout=timeout_s + 2,
        )
        return proc.returncode == 0
    except (subprocess.SubprocessError, OSError):
        return False


def _parse_wired(output: str) -> Dict[str, Any]:
    """Parse key=value lines from the `get-wired` helper output."""
    data: Dict[str, str] = {}
    for line in output.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            data[k.strip()] = v.strip()
    addresses = data.get("addresses", "")
    ip, prefix = None, None
    if "/" in addresses:
        ip, _, p = addresses.partition("/")
        ip = ip or None
        try:
            prefix = int(p)
        except ValueError:
            prefix = None
    dns_raw = data.get("dns", "")
    return {
        "connection": data.get("connection") or None,
        "device": data.get("device") or None,
        "carrier": data.get("carrier") == "1",
        "method": data.get("method") or "auto",
        "ip": ip,
        "prefix": prefix,
        "gateway": data.get("gateway") or None,
        "dns": [d for d in (s.strip() for s in dns_raw.split(",")) if d],
    }


def _parse_wifi(output: str) -> List[dict]:
    """Parse output of `nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY device wifi list`.

    Skips hidden/empty SSIDs, dedupes by SSID (keeps the strongest signal),
    sorts by signal strength descending.
    """
    nets: List[dict] = []
    for line in output.splitlines():
        if not line:
            continue
        parts = _split_nmcli(line)
        if len(parts) < 4:
            continue
        in_use, ssid, signal_str, security = parts[0], parts[1], parts[2], parts[3]
        if not ssid:
            continue
        try:
            signal = int(signal_str)
        except ValueError:
            signal = 0
        nets.append(
            {
                "in_use": in_use.strip() == "*",
                "ssid": ssid,
                "signal": signal,
                "security": security or "open",
            }
        )
    by_ssid: dict[str, dict] = {}
    for n in nets:
        existing = by_ssid.get(n["ssid"])
        if existing is None or n["signal"] > existing["signal"]:
            by_ssid[n["ssid"]] = n
    return sorted(by_ssid.values(), key=lambda x: x["signal"], reverse=True)


# ---------------------------------------------------------------------------
# routes
# ---------------------------------------------------------------------------

def _read_uptime_seconds() -> Optional[int]:
    """First field of /proc/uptime is seconds since boot. Returns None if the
    file is unreadable (e.g. macOS during local dev)."""
    try:
        with open("/proc/uptime") as f:
            return int(float(f.read().split()[0]))
    except (OSError, ValueError):
        return None


def _read_timezone() -> Optional[str]:
    """Return the Pi's IANA timezone (e.g. 'America/Chicago'). Reads
    /etc/timezone if present; otherwise resolves the /etc/localtime symlink
    target. Returns None on any failure so the caller (and the kiosk page)
    can fall back to '—'."""
    try:
        with open("/etc/timezone", "r", encoding="utf-8") as f:
            tz = f.read().strip()
            if tz:
                return tz
    except OSError:
        pass
    try:
        # /etc/localtime is usually a symlink into /usr/share/zoneinfo/<zone>;
        # everything after 'zoneinfo/' is the IANA name.
        target = os.readlink("/etc/localtime")
        marker = "zoneinfo/"
        idx = target.find(marker)
        if idx != -1:
            return target[idx + len(marker):]
    except OSError:
        pass
    return None


@router.get("")
def get_settings() -> dict:
    """Return current hostname + active network connections (each annotated
    with its IPv4 address) + the device's public WAN IP + boot uptime +
    configured timezone."""
    hostname = _run_helper("get-hostname").strip()
    conns = _parse_connections(_run_helper("get-active-connections"))
    device_ips = _get_device_ips()
    for c in conns:
        c["ip4"] = device_ips.get(c["device"], "")
    return {
        "hostname": hostname,
        "connections": conns,
        "wan_ip": _get_wan_ip(),
        "uptime_seconds": _read_uptime_seconds(),
        "timezone": _read_timezone(),
    }


@router.post("/hostname")
def set_hostname(body: HostnameRequest) -> dict:
    """Set the hostname and trigger a delayed reboot. The helper's reboot
    subcommand schedules the reboot in 5 seconds via a detached background
    process, so the HTTP response flushes first."""
    new = body.hostname.strip().lower()
    if not HOSTNAME_RE.match(new):
        raise HTTPException(
            status_code=400,
            detail="hostname must match RFC 1123 lowercase label "
            "(a-z, 0-9, hyphen; no leading/trailing hyphen)",
        )
    out = _run_helper("set-hostname", new).strip()
    log.info("set-hostname: %s", out)
    _run_helper("reboot")
    return {"ok": True, "hostname": new, "rebooting_in_seconds": 5}


@router.get("/wifi/networks")
def list_wifi() -> dict:
    """Scan for visible wifi networks. Refreshes nmcli's cache automatically."""
    return {"networks": _parse_wifi(_run_helper("list-wifi", timeout=45))}


# ---------------------------------------------------------------------------
# Hardware settings (stored in postgres local_app_settings)
# ---------------------------------------------------------------------------

_HARDWARE_KEYS = ("stacklight_enable", "audio_feedback")
_HARDWARE_DEFAULTS = {
    "stacklight_enable": StackLight.NOT_INSTALLED.value,
    "audio_feedback": AudioFeedback.NONE.value,
}


def _psql_exec(sql: str) -> bool:
    """Run a single SQL statement (write). Returns True on success."""
    try:
        proc = subprocess.run(
            ["psql", "-U", "csg", "-d", "stackpi", "-v", "ON_ERROR_STOP=1", "-c", sql],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (subprocess.SubprocessError, OSError) as e:
        log.warning("psql exec error: %s", e)
        return False
    if proc.returncode != 0:
        log.warning("psql exec exit=%d stderr=%s", proc.returncode, proc.stderr.strip())
        return False
    return True


def _psql_rows(sql: str) -> List[List[str]]:
    """Run a SELECT and return rows as lists of column strings."""
    try:
        proc = subprocess.run(
            ["psql", "-U", "csg", "-d", "stackpi", "-tAc", sql, "-F", "|"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (subprocess.SubprocessError, OSError):
        return []
    if proc.returncode != 0:
        return []
    return [line.split("|") for line in proc.stdout.splitlines() if line]


@router.get("/hardware")
def get_hardware() -> Dict[str, str]:
    rows = _psql_rows(
        "SELECT key, value FROM local_app_settings "
        f"WHERE key IN ({','.join(repr(k) for k in _HARDWARE_KEYS)})"
    )
    out = dict(_HARDWARE_DEFAULTS)
    for r in rows:
        if len(r) >= 2 and r[0] in _HARDWARE_KEYS:
            out[r[0]] = r[1]
    return out


# --- Screen-status settings (drives the /status kiosk page behavior) ------

_SCREEN_STATUS_KEY_AUTO_CLEAR     = "screen_status_auto_clear_minutes"
_SCREEN_STATUS_KEY_BORDER_WIDTH   = "screen_status_change_border_width_px"
_SCREEN_STATUS_KEY_BORDER_COLOR   = "screen_status_change_border_color"
_SCREEN_STATUS_KEY_CYCLE_COUNT    = "screen_status_change_border_cycle_count"
# Bumped to NOW() in UNIX milliseconds whenever an operator clicks the
# "Test" button on /config/settings/screen-status. The /status kiosk page
# polls screen-status every few seconds and runs the chase sequence when
# this value changes from what it last saw.
_SCREEN_STATUS_KEY_CHASE_TEST    = "screen_status_chase_test_triggered_at"
_SCREEN_STATUS_KEY_BORDER_STYLE  = "screen_status_change_border_style"

_SCREEN_STATUS_DEFAULT_AUTO_CLEAR    = 15
_SCREEN_STATUS_MIN_AUTO_CLEAR        = 1
_SCREEN_STATUS_MAX_AUTO_CLEAR        = 1440  # 24 h ceiling

_SCREEN_STATUS_DEFAULT_BORDER_WIDTH  = 10
_SCREEN_STATUS_MIN_BORDER_WIDTH      = 1
_SCREEN_STATUS_MAX_BORDER_WIDTH      = 50

_SCREEN_STATUS_DEFAULT_BORDER_COLOR  = "#22c55e"  # tailwind green-500

_SCREEN_STATUS_DEFAULT_CYCLE_COUNT   = 2
_SCREEN_STATUS_MIN_CYCLE_COUNT       = 1
_SCREEN_STATUS_MAX_CYCLE_COUNT       = 10

_SCREEN_STATUS_DEFAULT_BORDER_STYLE = "comet"
_SCREEN_STATUS_BORDER_STYLE_OPTIONS = ("comet", "pulse", "dual")
# Accept hex, rgb()/rgba(), hsl()/hsla(). Case-insensitive. Spaces tolerated.
_SCREEN_STATUS_COLOR_RE = re.compile(
    r"^\s*("
    r"#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})"
    r"|rgba?\([^)]+\)"
    r"|hsla?\([^)]+\)"
    r")\s*$",
    re.IGNORECASE,
)


class ScreenStatusRequest(BaseModel):
    """Body for POST /local/settings/screen-status. All fields optional —
    omitted ones keep their current persisted value."""
    auto_clear_minutes: Optional[int] = Field(
        default=None,
        ge=_SCREEN_STATUS_MIN_AUTO_CLEAR,
        le=_SCREEN_STATUS_MAX_AUTO_CLEAR,
    )
    change_border_width_px: Optional[int] = Field(
        default=None,
        ge=_SCREEN_STATUS_MIN_BORDER_WIDTH,
        le=_SCREEN_STATUS_MAX_BORDER_WIDTH,
    )
    change_border_color: Optional[str] = Field(default=None, max_length=64)
    change_border_cycle_count: Optional[int] = Field(
        default=None,
        ge=_SCREEN_STATUS_MIN_CYCLE_COUNT,
        le=_SCREEN_STATUS_MAX_CYCLE_COUNT,
    )
    change_border_style: Optional[str] = Field(default=None, max_length=16)


def _get_setting_int(key: str, default: int, lo: int, hi: int) -> int:
    rows = _psql_rows(
        f"SELECT value FROM local_app_settings WHERE key = '{key}' LIMIT 1"
    )
    if rows and rows[0]:
        try:
            return max(lo, min(hi, int(rows[0][0])))
        except (TypeError, ValueError):
            pass
    return default


def _get_setting_str(key: str, default: str) -> str:
    rows = _psql_rows(
        f"SELECT value FROM local_app_settings WHERE key = '{key}' LIMIT 1"
    )
    if rows and rows[0] and rows[0][0]:
        return rows[0][0]
    return default


def _persist_setting(key: str, value: str) -> bool:
    """INSERT … ON CONFLICT. `value` is single-quoted via repr-like escaping
    so any quotes in the color string don't break the statement. Key is a
    controlled constant — never an input — so direct substitution is safe."""
    safe_value = value.replace("'", "''")
    sql = (
        "INSERT INTO local_app_settings (key, value) "
        f"VALUES ('{key}', '{safe_value}') "
        "ON CONFLICT (key) DO UPDATE "
        "SET value = EXCLUDED.value, updated_at = NOW()"
    )
    return _psql_exec(sql)


TIMEZONE_AUTO_KEY = "timezone_auto"


def get_timezone_auto() -> bool:
    """Whether the timezone is auto-detected from the device location (on by
    default). A manual timezone set turns this off."""
    return _get_setting_str(TIMEZONE_AUTO_KEY, "1") == "1"


def set_timezone_auto(enabled: bool) -> bool:
    return _persist_setting(TIMEZONE_AUTO_KEY, "1" if enabled else "0")


def _get_screen_status_payload() -> Dict[str, Any]:
    _border_style = _get_setting_str(
        _SCREEN_STATUS_KEY_BORDER_STYLE,
        _SCREEN_STATUS_DEFAULT_BORDER_STYLE,
    )
    if _border_style not in _SCREEN_STATUS_BORDER_STYLE_OPTIONS:
        _border_style = _SCREEN_STATUS_DEFAULT_BORDER_STYLE
    return {
        "auto_clear_minutes": _get_setting_int(
            _SCREEN_STATUS_KEY_AUTO_CLEAR,
            _SCREEN_STATUS_DEFAULT_AUTO_CLEAR,
            _SCREEN_STATUS_MIN_AUTO_CLEAR,
            _SCREEN_STATUS_MAX_AUTO_CLEAR,
        ),
        "auto_clear_minutes_default": _SCREEN_STATUS_DEFAULT_AUTO_CLEAR,
        "auto_clear_minutes_min":     _SCREEN_STATUS_MIN_AUTO_CLEAR,
        "auto_clear_minutes_max":     _SCREEN_STATUS_MAX_AUTO_CLEAR,

        "change_border_width_px": _get_setting_int(
            _SCREEN_STATUS_KEY_BORDER_WIDTH,
            _SCREEN_STATUS_DEFAULT_BORDER_WIDTH,
            _SCREEN_STATUS_MIN_BORDER_WIDTH,
            _SCREEN_STATUS_MAX_BORDER_WIDTH,
        ),
        "change_border_width_px_default": _SCREEN_STATUS_DEFAULT_BORDER_WIDTH,
        "change_border_width_px_min":     _SCREEN_STATUS_MIN_BORDER_WIDTH,
        "change_border_width_px_max":     _SCREEN_STATUS_MAX_BORDER_WIDTH,

        "change_border_color": _get_setting_str(
            _SCREEN_STATUS_KEY_BORDER_COLOR,
            _SCREEN_STATUS_DEFAULT_BORDER_COLOR,
        ),
        "change_border_color_default": _SCREEN_STATUS_DEFAULT_BORDER_COLOR,

        "change_border_cycle_count": _get_setting_int(
            _SCREEN_STATUS_KEY_CYCLE_COUNT,
            _SCREEN_STATUS_DEFAULT_CYCLE_COUNT,
            _SCREEN_STATUS_MIN_CYCLE_COUNT,
            _SCREEN_STATUS_MAX_CYCLE_COUNT,
        ),
        "change_border_cycle_count_default": _SCREEN_STATUS_DEFAULT_CYCLE_COUNT,
        "change_border_cycle_count_min":     _SCREEN_STATUS_MIN_CYCLE_COUNT,
        "change_border_cycle_count_max":     _SCREEN_STATUS_MAX_CYCLE_COUNT,

        "change_border_style": _border_style,
        "change_border_style_default": _SCREEN_STATUS_DEFAULT_BORDER_STYLE,
        "change_border_style_options": list(_SCREEN_STATUS_BORDER_STYLE_OPTIONS),

        "chase_test_triggered_at": _get_setting_int(
            _SCREEN_STATUS_KEY_CHASE_TEST, 0, 0, 2_000_000_000_000
        ),
    }


@router.get("/screen-status")
def get_screen_status_settings() -> Dict[str, Any]:
    """Return all configurable behavior of the /status kiosk page plus
    defaults and bounds (the form uses these for helper text)."""
    return _get_screen_status_payload()


@router.post("/screen-status/test")
def trigger_screen_status_chase_test() -> Dict[str, Any]:
    """Bump the chase-test trigger timestamp. The /status kiosk page polls
    /local/settings/screen-status and runs the chase sequence whenever
    `chase_test_triggered_at` changes from what it last saw."""
    import time as _time
    now_ms = int(_time.time() * 1000)
    if not _persist_setting(_SCREEN_STATUS_KEY_CHASE_TEST, str(now_ms)):
        raise HTTPException(status_code=500, detail="failed to persist trigger")
    return {"triggered_at": now_ms}


@router.post("/screen-status")
def set_screen_status_settings(body: ScreenStatusRequest) -> Dict[str, Any]:
    """Persist any subset of screen-status settings. Returns the full
    settings payload so the form can re-render without a follow-up GET."""
    if body.auto_clear_minutes is not None:
        if not _persist_setting(
            _SCREEN_STATUS_KEY_AUTO_CLEAR, str(int(body.auto_clear_minutes))
        ):
            raise HTTPException(status_code=500, detail="failed to persist auto_clear_minutes")

    if body.change_border_width_px is not None:
        if not _persist_setting(
            _SCREEN_STATUS_KEY_BORDER_WIDTH,
            str(int(body.change_border_width_px)),
        ):
            raise HTTPException(status_code=500, detail="failed to persist change_border_width_px")

    if body.change_border_color is not None:
        candidate = body.change_border_color.strip()
        if not _SCREEN_STATUS_COLOR_RE.match(candidate):
            raise HTTPException(
                status_code=400,
                detail="change_border_color must be a hex, rgb()/rgba(), or hsl()/hsla() string",
            )
        if not _persist_setting(_SCREEN_STATUS_KEY_BORDER_COLOR, candidate):
            raise HTTPException(status_code=500, detail="failed to persist change_border_color")

    if body.change_border_cycle_count is not None:
        if not _persist_setting(
            _SCREEN_STATUS_KEY_CYCLE_COUNT,
            str(int(body.change_border_cycle_count)),
        ):
            raise HTTPException(status_code=500, detail="failed to persist change_border_cycle_count")

    if body.change_border_style is not None:
        candidate = body.change_border_style.strip().lower()
        if candidate not in _SCREEN_STATUS_BORDER_STYLE_OPTIONS:
            raise HTTPException(
                status_code=400,
                detail="change_border_style must be one of: "
                + ", ".join(_SCREEN_STATUS_BORDER_STYLE_OPTIONS),
            )
        if not _persist_setting(_SCREEN_STATUS_KEY_BORDER_STYLE, candidate):
            raise HTTPException(
                status_code=500, detail="failed to persist change_border_style"
            )

    return _get_screen_status_payload()


@router.get("/device-status")
def get_device_status_settings() -> Dict[str, Any]:
    """The status-check interval (used by the engine heartbeat loop + as the
    /local/status freshness window). Operator-configurable on /config."""
    from app.cloud_status import (  # noqa: PLC0415
        KEY_STATUS_INTERVAL, STATUS_INTERVAL_DEFAULT, STATUS_INTERVAL_MIN, STATUS_INTERVAL_MAX,
    )
    return {
        "interval_seconds": _get_setting_int(
            KEY_STATUS_INTERVAL, STATUS_INTERVAL_DEFAULT, STATUS_INTERVAL_MIN, STATUS_INTERVAL_MAX
        ),
        "interval_seconds_default": STATUS_INTERVAL_DEFAULT,
        "interval_seconds_min": STATUS_INTERVAL_MIN,
        "interval_seconds_max": STATUS_INTERVAL_MAX,
    }


class DeviceStatusRequest(BaseModel):
    interval_seconds: int = Field(ge=10, le=300)


@router.post("/device-status")
def set_device_status_settings(body: DeviceStatusRequest) -> Dict[str, Any]:
    from app.cloud_status import KEY_STATUS_INTERVAL  # noqa: PLC0415
    if not _persist_setting(KEY_STATUS_INTERVAL, str(int(body.interval_seconds))):
        raise HTTPException(status_code=500, detail="failed to persist interval_seconds")
    return get_device_status_settings()


@router.post("/hardware")
def set_hardware(body: HardwareRequest) -> Dict[str, str]:
    updates = {
        "stacklight_enable": body.stacklight_enable.value
        if body.stacklight_enable
        else None,
        "audio_feedback": body.audio_feedback.value if body.audio_feedback else None,
    }
    for key, value in updates.items():
        if value is None:
            continue
        # Both key + value are constrained — key by the dict above, value by
        # the Pydantic enum. Literal substitution is safe here.
        sql = (
            "INSERT INTO local_app_settings (key, value) "
            f"VALUES ('{key}', '{value}') "
            "ON CONFLICT (key) DO UPDATE "
            "SET value = EXCLUDED.value, updated_at = NOW()"
        )
        if not _psql_exec(sql):
            raise HTTPException(
                status_code=500, detail=f"failed to persist {key}"
            )
    return get_hardware()


# ---------------------------------------------------------------------------
# Time / NTP
# ---------------------------------------------------------------------------

_TZ_FALLBACK = re.compile(r"^[A-Za-z][A-Za-z0-9_+-]*(?:/[A-Za-z0-9_+-]+)*$")


def _parse_kv(text: str) -> Dict[str, str]:
    """Parse simple `key=value` lines into a dict. Lines without `=` skipped."""
    out: Dict[str, str] = {}
    for line in (text or "").splitlines():
        if "=" not in line:
            continue
        k, _, v = line.partition("=")
        out[k.strip()] = v.strip()
    return out


@router.get("/time")
def get_time_status() -> Dict[str, Any]:
    """Aggregate timezone + sync info + configured NTP server overrides."""
    status = _parse_kv(_run_helper("get-time-status"))
    servers_raw = _run_helper("get-ntp-servers").strip()
    servers = [s for s in servers_raw.split() if s] if servers_raw else []
    return {
        "timezone":       status.get("timezone"),
        "local_time":     status.get("local_time"),
        "utc_time":       status.get("utc_time"),
        "ntp_active":     status.get("ntp_active") == "yes",
        "synchronized":   status.get("synchronized") == "yes",
        "current_server": status.get("current_server") or None,
        "ntp_servers_override": servers,  # empty list = using defaults
        "timezone_auto": get_timezone_auto(),
    }


@router.post("/time/timezone")
def set_timezone(body: TimezoneRequest) -> Dict[str, Any]:
    tz = body.timezone.strip()
    if not _TZ_FALLBACK.match(tz):
        raise HTTPException(
            status_code=400,
            detail="bad timezone format; expected e.g. America/Chicago",
        )
    _run_helper("set-timezone", tz)
    set_timezone_auto(False)  # a manual set is an override
    return get_time_status()


@router.post("/time/ntp")
def set_ntp_servers(body: NTPRequest) -> Dict[str, Any]:
    servers = [s.strip() for s in (body.servers or []) if s and s.strip()]
    for s in servers:
        # API-side regex matches the helper's regex shape.
        if not re.match(r"^[A-Za-z0-9.:_-]+$", s) or len(s) > 253:
            raise HTTPException(
                status_code=400, detail=f"invalid NTP server: {s!r}"
            )
    args = ["set-ntp-servers", *servers]
    _run_helper(*args, timeout=30)
    return get_time_status()


@router.post("/time/timezone-auto")
def set_timezone_auto_route(body: TimezoneAutoRequest) -> Dict[str, Any]:
    set_timezone_auto(body.enabled)
    if body.enabled:
        from app import tz_auto  # noqa: PLC0415
        tz_auto.apply_once()  # detect immediately on enable (best-effort)
    return get_time_status()


@router.post("/wifi/connect")
def connect_wifi(body: WifiConnectRequest) -> dict:
    """Connect to a wifi network. Returns success once NetworkManager has
    activated the connection profile (nmcli blocks until done)."""
    # Defensive trim: a UI copy/paste can drop a trailing \n or whitespace
    # into the SSID. Trim before validating + passing to the helper.
    ssid = (body.ssid or "").strip()
    password = (body.password or "").strip() if body.password else ""
    if not ssid:
        raise HTTPException(status_code=400, detail="ssid is required")
    if "\x00" in ssid:
        raise HTTPException(status_code=400, detail="invalid ssid (null byte)")
    # Helper expects positional args: ssid, password (may be empty), hidden flag.
    args = ["connect-wifi", ssid, password, "yes" if body.hidden else "no"]
    out = _run_helper(*args, timeout=60).strip()
    return {"ok": True, "ssid": ssid, "nmcli_output": out}


@router.post("/wifi/disconnect")
def disconnect_wifi(body: WifiDisconnectRequest) -> dict:
    """Bring down the active NM connection for the named SSID."""
    ssid = (body.ssid or "").strip()
    if not ssid:
        raise HTTPException(status_code=400, detail="ssid is required")
    if "\x00" in ssid:
        raise HTTPException(status_code=400, detail="invalid ssid (null byte)")
    out = _run_helper("disconnect-wifi", ssid, timeout=30).strip()
    return {"ok": True, "ssid": ssid, "nmcli_output": out}


@router.get("/connectivity")
def get_connectivity() -> Dict[str, Any]:
    """Local-link + internet + portal reachability for the kiosk.
    gateway_ok  = default gateway answers ICMP (we have a usable LAN);
    portal_ok   = the StackPI portal host answers (we can reach the cloud);
    internet_ok = the portal OR a general host answers (we have real internet)."""
    gateway = _default_gateway()
    gateway_ok = bool(gateway) and _ping(gateway)
    portal_host = _CONNECTIVITY_HOSTS[0]  # portal.serversherpa.com
    portal_ok = _ping(portal_host)
    # If the portal is reachable we already have internet; otherwise probe a
    # general host to tell "internet but portal down" (yellow) from "no
    # internet" (red).
    internet_ok = portal_ok or any(_ping(h) for h in _CONNECTIVITY_HOSTS[1:])
    return {
        "gateway": gateway,
        "gateway_ok": gateway_ok,
        "internet_ok": internet_ok,
        "portal_ok": portal_ok,
        "portal_host": portal_host,
        "checked": list(_CONNECTIVITY_HOSTS),
    }


@router.get("/wired")
def get_wired() -> Dict[str, Any]:
    """Return the current wired (ethernet) connection configuration."""
    return _parse_wired(_run_helper("get-wired"))


@router.post("/wired")
def set_wired(body: WiredConfigRequest) -> Dict[str, Any]:
    """Switch the wired connection to DHCP (method=auto) or a static IPv4
    configuration (method=manual). Returns the resulting wired state."""
    if body.method == "auto":
        _run_helper("set-wired-dhcp", timeout=30)
        return get_wired()
    # manual
    s = body.static
    if s is None:
        raise HTTPException(status_code=400, detail="static config required when method=manual")
    # Validate IPs before touching nmcli.
    try:
        ipaddress.IPv4Address(s.ip.strip())
        ipaddress.IPv4Address(s.gateway.strip())
        for d in s.dns:
            if d.strip():
                ipaddress.IPv4Address(d.strip())
    except ipaddress.AddressValueError as e:
        raise HTTPException(status_code=400, detail=f"invalid IPv4 address: {e}")
    dns_csv = ",".join(d.strip() for d in s.dns if d.strip())
    _run_helper(
        "set-wired-static", s.ip.strip(), str(s.prefix), s.gateway.strip(), dns_csv,
        timeout=30,
    )
    return get_wired()
