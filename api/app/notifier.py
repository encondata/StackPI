"""Stack-light / buzzer notifications over UDP multicast.

A small bridge that turns StackPI events (bad-tag alerts, reader traffic-light
status — wired in a later pass) into JSON notification messages and sends them
to networked stack lights as a single UDP multicast datagram.

Wire format (UTF-8 JSON, one datagram):

  light:  {"v":1,"type":"light","pattern":"solid|flash|pulse",
           "color":"red|green|yellow|blue","brightness":0-100,
           "duration":<ms>,"repeat_count":1-5}
  sound:  {"v":1,"type":"sound","sound":"<name>","volume":0-100,
           "duration":<ms>,"repeat_count":1-5}

Group/port/enable live in local_app_settings (operator-editable on
/config → Notifications). Sending is best-effort: failures are logged, never
raised, so a notification can never break the path that triggered it.
"""
import ipaddress
import json
import logging
import socket
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

log = logging.getLogger("stackpi.notifier")

router = APIRouter(prefix="/local/notify", tags=["local-notify"])

SCHEMA_VERSION = 1
MULTICAST_TTL = 1  # LAN-local; stack lights sit on the same segment.

# --- settings keys (local_app_settings) -----------------------------------
KEY_ENABLE = "notify_enable"
KEY_GROUP = "notify_multicast_group"
KEY_PORT = "notify_multicast_port"
KEY_READER_LIGHT_ENABLE = "notify_reader_light_enable"

DEFAULT_GROUP = "239.10.10.10"
DEFAULT_PORT = 5005
DURATION_MAX_MS = 600_000  # 10 min — a sanity ceiling, not a real limit

# Reader traffic-light → stack light. The light is a 4-channel tower (separate
# red/green/yellow/blue segments); a message only drives ITS OWN color's channel
# and never clears the others. So to show a state we must set ALL FOUR channels
# every time (the lit ones to brightness, the rest to 0) — otherwise a previously
# lit color stays on (the "stuck green" bug). Colors mirror the on-screen reader
# traffic light, which can co-light blue+green while reading.
READER_LIGHT_COLORS = ("red", "green", "yellow", "blue")
READER_LIGHT_BRIGHTNESS = 80


def _get_int(key: str, default: int, lo: int, hi: int) -> int:
    from app.settings import _get_setting_int  # noqa: PLC0415
    return _get_setting_int(key, default, lo, hi)


def _get_str(key: str, default: str) -> str:
    from app.settings import _get_setting_str  # noqa: PLC0415
    return _get_setting_str(key, default)


def _enabled() -> bool:
    return _get_int(KEY_ENABLE, 1, 0, 1) == 1


def _reader_light_enabled() -> bool:
    return _get_int(KEY_READER_LIGHT_ENABLE, 1, 0, 1) == 1


def send_reader_light(channels: Dict[str, bool]) -> bool:
    """Drive the reader traffic-light tower to exactly `channels` (a dict of
    color→on/off, e.g. {"blue": True, "green": True}). Sends one SOLID message per
    color — lit ones at full brightness, the rest at 0 — so stale colors clear.
    Gated by the master notify-enable AND the reader-light toggle. Best-effort."""
    if not _enabled() or not _reader_light_enabled():
        return False
    group, port = _notify_target()
    ok = True
    for color in READER_LIGHT_COLORS:
        bright = READER_LIGHT_BRIGHTNESS if channels.get(color) else 0
        msg = LightMessage(pattern="solid", color=color, brightness=bright, duration=1000, repeat_count=1)
        ok = _emit(_light_payload(msg), group, port) and ok
    return ok


# ---------------------------------------------------------------------------
# Message models — range-validated; reused by the senders AND the test routes.
# ---------------------------------------------------------------------------

class LightMessage(BaseModel):
    pattern: Literal["solid", "flash", "pulse"]
    color: Literal["red", "green", "yellow", "blue"]
    brightness: int = Field(ge=0, le=100)
    duration: int = Field(ge=0, le=DURATION_MAX_MS)  # ms
    repeat_count: int = Field(ge=1, le=5)


class SoundMessage(BaseModel):
    sound: str = Field(min_length=1, max_length=40)
    volume: int = Field(ge=0, le=100)
    duration: int = Field(ge=0, le=DURATION_MAX_MS)  # ms
    repeat_count: int = Field(ge=1, le=5)


def _light_payload(m: LightMessage) -> Dict[str, Any]:
    return {"v": SCHEMA_VERSION, "type": "light", **m.model_dump()}


def _sound_payload(m: SoundMessage) -> Dict[str, Any]:
    return {"v": SCHEMA_VERSION, "type": "sound", **m.model_dump()}


# ---------------------------------------------------------------------------
# Transport
# ---------------------------------------------------------------------------

def _notify_target() -> tuple:
    """The stack-light notifier's multicast (group, port)."""
    return (
        _get_str(KEY_GROUP, DEFAULT_GROUP),
        _get_int(KEY_PORT, DEFAULT_PORT, 1, 65535),
    )


def _emit(payload: Dict[str, Any], group: str, port: int) -> bool:
    """Send one JSON datagram to the given multicast group/port. Best-effort:
    returns False (and logs) on any error rather than raising. Does NOT check
    any enable flag — callers gate. Shared by the stack-light senders and the
    status broadcaster (each passes its own group/port)."""
    data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        try:
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, MULTICAST_TTL)
            sock.sendto(data, (group, port))
        finally:
            sock.close()
        return True
    except OSError as e:
        log.warning("notify send to %s:%s failed: %s", group, port, e)
        return False


# --- public send API (used by event hooks in a later pass) -----------------

def send_light(msg: LightMessage) -> bool:
    """Send a light notification, honoring the enable flag."""
    if not _enabled():
        return False
    return _emit(_light_payload(msg), *_notify_target())


def send_sound(msg: SoundMessage) -> bool:
    """Send a sound notification, honoring the enable flag."""
    if not _enabled():
        return False
    return _emit(_sound_payload(msg), *_notify_target())


# ---------------------------------------------------------------------------
# Config + test endpoints (/config → Notifications)
# ---------------------------------------------------------------------------

@router.get("/config")
def get_config() -> dict:
    return {
        "enabled": _enabled(),
        "multicast_group": _get_str(KEY_GROUP, DEFAULT_GROUP),
        "multicast_port": _get_int(KEY_PORT, DEFAULT_PORT, 1, 65535),
        "reader_light_enabled": _reader_light_enabled(),
        "group_default": DEFAULT_GROUP,
        "port_default": DEFAULT_PORT,
    }


class NotifyConfigRequest(BaseModel):
    enabled: bool
    multicast_group: str = Field(min_length=7, max_length=15)
    multicast_port: int = Field(ge=1, le=65535)
    reader_light_enabled: bool = True


@router.post("/config")
def set_config(body: NotifyConfigRequest) -> dict:
    from app.settings import _persist_setting  # noqa: PLC0415

    try:
        if not ipaddress.IPv4Address(body.multicast_group).is_multicast:
            raise ValueError
    except (ipaddress.AddressValueError, ValueError):
        raise HTTPException(
            status_code=400,
            detail="multicast_group must be an IPv4 multicast address (224.0.0.0–239.255.255.255)",
        )
    ok = (
        _persist_setting(KEY_ENABLE, "1" if body.enabled else "0")
        and _persist_setting(KEY_GROUP, body.multicast_group)
        and _persist_setting(KEY_PORT, str(int(body.multicast_port)))
        and _persist_setting(KEY_READER_LIGHT_ENABLE, "1" if body.reader_light_enabled else "0")
    )
    if not ok:
        raise HTTPException(status_code=500, detail="failed to persist notify config")
    return get_config()


@router.post("/test/light")
def test_light(body: LightMessage) -> dict:
    """Send a light message now (always fires, regardless of the enable flag)."""
    payload = _light_payload(body)
    return {"ok": _emit(payload, *_notify_target()), "sent": payload}


@router.post("/test/sound")
def test_sound(body: SoundMessage) -> dict:
    """Send a sound message now (always fires, regardless of the enable flag)."""
    payload = _sound_payload(body)
    return {"ok": _emit(payload, *_notify_target()), "sent": payload}


# --- status-broadcast config (separate multicast group/port) ----------------

@router.get("/status-config")
def get_status_config() -> dict:
    from app import status_broadcast as sb  # noqa: PLC0415

    return {
        "enabled": sb.status_enabled(),
        "multicast_group": _get_str(sb.KEY_STATUS_GROUP, sb.DEFAULT_STATUS_GROUP),
        "multicast_port": _get_int(sb.KEY_STATUS_PORT, sb.DEFAULT_STATUS_PORT, 1, 65535),
        "group_default": sb.DEFAULT_STATUS_GROUP,
        "port_default": sb.DEFAULT_STATUS_PORT,
        # What-to-send tick boxes: the catalog (id/label/group) + the disabled
        # ids (denylist). A checkbox is ticked when its id is NOT in `excluded`.
        "catalog": sb.STATUS_CATALOG,
        "excluded": sorted(sb.status_excluded()),
    }


class StatusConfigRequest(NotifyConfigRequest):
    # Disabled toggle ids (denylist). Unknown ids are ignored on save.
    excluded: List[str] = Field(default_factory=list)


@router.post("/status-config")
def set_status_config(body: StatusConfigRequest) -> dict:
    from app.settings import _persist_setting  # noqa: PLC0415
    from app import status_broadcast as sb  # noqa: PLC0415

    try:
        if not ipaddress.IPv4Address(body.multicast_group).is_multicast:
            raise ValueError
    except (ipaddress.AddressValueError, ValueError):
        raise HTTPException(
            status_code=400,
            detail="multicast_group must be an IPv4 multicast address (224.0.0.0–239.255.255.255)",
        )
    excluded = sorted(set(body.excluded) & sb.CATALOG_IDS)
    ok = (
        _persist_setting(sb.KEY_STATUS_ENABLE, "1" if body.enabled else "0")
        and _persist_setting(sb.KEY_STATUS_GROUP, body.multicast_group)
        and _persist_setting(sb.KEY_STATUS_PORT, str(int(body.multicast_port)))
        and _persist_setting(sb.KEY_STATUS_EXCLUDE, ",".join(excluded))
    )
    if not ok:
        raise HTTPException(status_code=500, detail="failed to persist status config")
    return get_status_config()
