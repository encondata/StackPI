"""RFID "bad tag" alerts — sound + screen flash + System Event.

When a scanned tag is a known asset (present in local_asset_tags) that is NOT
part of the active move (no cloud_sync_moves_assets match), it is flagged. The
ingest path collects these and, AFTER the DB transaction commits, calls
``fire()`` for each — which (per-tag debounced) plays a configured sound on the
Pi and emits a ``kind="alert"`` System Event. The kiosk's FlashAlertOverlay
turns that event into a full-screen yellow/red flash; it's also logged to the
System Events feed for audit.

Audio + System-Events I/O happen post-commit so they never hold the ingest
transaction. Settings live in local_app_settings (operator-configurable on
/config → Alerts).
"""
import logging
import os
import subprocess
import time
from typing import Dict, List, Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

log = logging.getLogger("stackpi.alerts")

router = APIRouter(prefix="/local/alerts", tags=["local-alerts"])

# --- settings keys (local_app_settings) -----------------------------------
KEY_DEBOUNCE = "alert_debounce_seconds"
KEY_SOUND = "alert_sound_file"
KEY_VOLUME = "alert_volume_pct"

DEBOUNCE_DEFAULT = 30
DEBOUNCE_MIN = 5
DEBOUNCE_MAX = 300
VOLUME_DEFAULT = 80
DEFAULT_SOUND = "alert.wav"
SOUND_NONE = "none"  # selectable "silent" option

# Installed from deploy/assets/sounds by deploy.sh.
SOUNDS_DIR = "/etc/stackpi/sounds"

# Per-tag debounce: id_hex -> monotonic time of last fire. Lives for the life
# of the API process; bounded by the number of distinct flagged tags seen.
_last_fired: Dict[str, float] = {}


def _get_int(key: str, default: int, lo: int, hi: int) -> int:
    from app.settings import _get_setting_int  # noqa: PLC0415
    return _get_setting_int(key, default, lo, hi)


def _get_str(key: str, default: str) -> str:
    from app.settings import _get_setting_str  # noqa: PLC0415
    return _get_setting_str(key, default)


def list_sounds() -> List[str]:
    """Available alert WAVs (filenames) bundled on the device."""
    try:
        return sorted(
            f for f in os.listdir(SOUNDS_DIR) if f.lower().endswith(".wav")
        )
    except OSError:
        return []


def play_sound() -> None:
    """Play the configured alert WAV at the configured volume, non-blocking.
    Silent if the sound is set to 'none', volume is 0, or the file is missing.
    Best-effort: a missing player / audio device is logged, never raised."""
    sound = (_get_str(KEY_SOUND, DEFAULT_SOUND) or "").strip()
    if not sound or sound.lower() == SOUND_NONE:
        return
    vol = _get_int(KEY_VOLUME, VOLUME_DEFAULT, 0, 100)
    if vol <= 0:
        return
    path = os.path.join(SOUNDS_DIR, os.path.basename(sound))
    if not os.path.exists(path):
        log.warning("alert sound not found: %s", path)
        return
    # Prefer paplay (PipeWire/Pulse on current Pi OS) with scaled volume
    # (0..65536); fall back to aplay (ALSA, no per-play volume).
    pa_vol = max(0, min(65536, int(65536 * vol / 100)))
    try:
        subprocess.Popen(
            ["paplay", f"--volume={pa_vol}", path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return
    except (OSError, ValueError):
        pass
    try:
        subprocess.Popen(
            ["aplay", "-q", path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError as e:
        log.warning("alert sound playback failed (no paplay/aplay?): %s", e)


def fire(
    id_hex: str,
    serial: Optional[str] = None,
    name: Optional[str] = None,
    reader_name: Optional[str] = None,
    severity: str = "critical",
) -> bool:
    """Fire a bad-tag alert (debounced per id_hex). Plays the sound and emits
    a kind='alert' System Event. Returns True if it actually fired (False if
    debounced). Never raises."""
    try:
        window = _get_int(KEY_DEBOUNCE, DEBOUNCE_DEFAULT, DEBOUNCE_MIN, DEBOUNCE_MAX)
        now = time.monotonic()
        last = _last_fired.get(id_hex)
        if last is not None and (now - last) < window:
            return False
        _last_fired[id_hex] = now

        label = serial or name or id_hex
        msg = "Not in move: " + label + (f" at {reader_name}" if reader_name else "")
        play_sound()
        from app import system_events  # noqa: PLC0415
        # detail carries severity → drives the flash color (critical=red,
        # warning=yellow). v1 "not in move" is critical/red.
        system_events.emit("rfid-alert", "alert", msg, severity)
        return True
    except Exception as e:  # pragma: no cover - alert must never break ingest
        log.warning("alert fire failed for %s: %s", id_hex, e)
        return False


# --- config endpoints (used by /config → Alerts) --------------------------

@router.get("/config")
def get_alert_config() -> dict:
    return {
        "sound_file": _get_str(KEY_SOUND, DEFAULT_SOUND),
        "sound_file_default": DEFAULT_SOUND,
        "volume_pct": _get_int(KEY_VOLUME, VOLUME_DEFAULT, 0, 100),
        "volume_pct_default": VOLUME_DEFAULT,
        "debounce_seconds": _get_int(KEY_DEBOUNCE, DEBOUNCE_DEFAULT, DEBOUNCE_MIN, DEBOUNCE_MAX),
        "debounce_seconds_default": DEBOUNCE_DEFAULT,
        "debounce_seconds_min": DEBOUNCE_MIN,
        "debounce_seconds_max": DEBOUNCE_MAX,
        "sounds": [SOUND_NONE, *list_sounds()],
    }


class AlertConfigRequest(BaseModel):
    sound_file: str = Field(min_length=1, max_length=120)
    volume_pct: int = Field(ge=0, le=100)
    debounce_seconds: int = Field(ge=DEBOUNCE_MIN, le=DEBOUNCE_MAX)


@router.post("/config")
def set_alert_config(body: AlertConfigRequest) -> dict:
    from fastapi import HTTPException  # noqa: PLC0415
    from app.settings import _persist_setting  # noqa: PLC0415

    # Sound must be 'none' or one of the bundled files.
    if body.sound_file != SOUND_NONE and body.sound_file not in list_sounds():
        raise HTTPException(status_code=400, detail="unknown sound file")
    ok = (
        _persist_setting(KEY_SOUND, body.sound_file)
        and _persist_setting(KEY_VOLUME, str(int(body.volume_pct)))
        and _persist_setting(KEY_DEBOUNCE, str(int(body.debounce_seconds)))
    )
    if not ok:
        raise HTTPException(status_code=500, detail="failed to persist alert config")
    return get_alert_config()


@router.post("/test")
def test_alert_sound() -> dict:
    """Preview the configured alert sound at the configured volume."""
    play_sound()
    return {"ok": True}
