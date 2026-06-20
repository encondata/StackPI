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
from typing import Any, Dict, Literal

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

DEFAULT_GROUP = "239.10.10.10"
DEFAULT_PORT = 5005
DURATION_MAX_MS = 600_000  # 10 min — a sanity ceiling, not a real limit


def _get_int(key: str, default: int, lo: int, hi: int) -> int:
    from app.settings import _get_setting_int  # noqa: PLC0415
    return _get_setting_int(key, default, lo, hi)


def _get_str(key: str, default: str) -> str:
    from app.settings import _get_setting_str  # noqa: PLC0415
    return _get_setting_str(key, default)


def _enabled() -> bool:
    return _get_int(KEY_ENABLE, 1, 0, 1) == 1


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

def _emit(payload: Dict[str, Any]) -> bool:
    """Send one JSON datagram to the configured multicast group. Best-effort:
    returns False (and logs) on any error rather than raising. Does NOT check
    the enable flag — that gating is in send_light/send_sound so the test
    endpoints can always fire."""
    group = _get_str(KEY_GROUP, DEFAULT_GROUP)
    port = _get_int(KEY_PORT, DEFAULT_PORT, 1, 65535)
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
    return _emit(_light_payload(msg))


def send_sound(msg: SoundMessage) -> bool:
    """Send a sound notification, honoring the enable flag."""
    if not _enabled():
        return False
    return _emit(_sound_payload(msg))


# ---------------------------------------------------------------------------
# Config + test endpoints (/config → Notifications)
# ---------------------------------------------------------------------------

@router.get("/config")
def get_config() -> dict:
    return {
        "enabled": _enabled(),
        "multicast_group": _get_str(KEY_GROUP, DEFAULT_GROUP),
        "multicast_port": _get_int(KEY_PORT, DEFAULT_PORT, 1, 65535),
        "group_default": DEFAULT_GROUP,
        "port_default": DEFAULT_PORT,
    }


class NotifyConfigRequest(BaseModel):
    enabled: bool
    multicast_group: str = Field(min_length=7, max_length=15)
    multicast_port: int = Field(ge=1, le=65535)


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
    )
    if not ok:
        raise HTTPException(status_code=500, detail="failed to persist notify config")
    return get_config()


@router.post("/test/light")
def test_light(body: LightMessage) -> dict:
    """Send a light message now (always fires, regardless of the enable flag)."""
    payload = _light_payload(body)
    return {"ok": _emit(payload), "sent": payload}


@router.post("/test/sound")
def test_sound(body: SoundMessage) -> dict:
    """Send a sound message now (always fires, regardless of the enable flag)."""
    payload = _sound_payload(body)
    return {"ok": _emit(payload), "sent": payload}
