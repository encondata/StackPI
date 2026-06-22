"""Audio feedback — play a sound on the Pi speaker for system events.

Three categories — error / alert / info — each map to a WAV (bundled or
uploaded) plus a play/silence toggle. system_events.emit() routes every event
to a category by its kind/severity (critical→error, warning→alert, info→info)
and plays the mapped sound via paplay/aplay (post-commit, never blocking the
caller). Operators configure this on /config → Settings → Audio, including
drag-and-drop upload of new sounds (mp3/ogg are transcoded to WAV with ffmpeg).

Settings live in local_app_settings; sounds live in SOUNDS_DIR (csg-writable,
so uploads work — the bundled WAVs are installed there by deploy.sh).
"""
import logging
import os
import re
import shutil
import subprocess
import time
from typing import Dict, List, Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

log = logging.getLogger("stackpi.audio")

router = APIRouter(prefix="/local/audio", tags=["local-audio"])

CATEGORIES = ("error", "alert", "info")
SOUNDS_DIR = "/etc/stackpi/sounds"          # deploy.sh chowns this to csg
SOUND_NONE = "none"                          # selectable "silent" option
VOLUME_DEFAULT = 80
VOLUME_MAX = 400                             # >100% overdrives (software gain; may clip)
DEBOUNCE_SEC = 2.0                           # per-category min spacing (anti-spam)
MAX_UPLOAD_BYTES = 8 * 1024 * 1024
ALLOWED_EXT = {".wav", ".mp3", ".ogg"}
FFMPEG_TIMEOUT = 30

# settings keys
KEY_FILE = {c: f"audio_sound_{c}" for c in CATEGORIES}
KEY_ENABLE = {c: f"audio_enable_{c}" for c in CATEGORIES}
KEY_VOLUME = "audio_volume_pct"
DEFAULT_FILE = {"error": "alert.wav", "alert": "buzz.wav", "info": "chime.wav"}
DEFAULT_ENABLE = {"error": 1, "alert": 1, "info": 0}  # info silent by default (noisy)

# Per-category debounce so a burst of events doesn't machine-gun the speaker.
_last_played: Dict[str, float] = {}


def _get_int(key: str, default: int, lo: int, hi: int) -> int:
    from app.settings import _get_setting_int  # noqa: PLC0415
    return _get_setting_int(key, default, lo, hi)


def _get_str(key: str, default: str) -> str:
    from app.settings import _get_setting_str  # noqa: PLC0415
    return _get_setting_str(key, default)


def list_sounds() -> List[str]:
    """Available sound files (WAVs) on the device — bundled + uploaded."""
    try:
        return sorted(f for f in os.listdir(SOUNDS_DIR) if f.lower().endswith(".wav"))
    except OSError:
        return []


def _category_enabled(cat: str) -> bool:
    return _get_int(KEY_ENABLE[cat], DEFAULT_ENABLE[cat], 0, 1) == 1


def _category_sound(cat: str) -> str:
    return (_get_str(KEY_FILE[cat], DEFAULT_FILE[cat]) or "").strip()


def _play_file(filename: str, volume: int) -> None:
    """Play a sound non-blocking at `volume` percent. Silent for 'none' /
    volume 0 / missing file. Volume can exceed 100% (overdrive): aplay has no
    gain, so we apply software gain with ffmpeg and pipe to aplay; >100% boosts
    the level (and may clip — that's the point). Falls back to paplay then plain
    aplay where ffmpeg is absent."""
    if not filename or filename.lower() == SOUND_NONE or volume <= 0:
        return
    path = os.path.join(SOUNDS_DIR, os.path.basename(filename))
    if not os.path.exists(path):
        log.warning("audio file not found: %s", path)
        return
    factor = volume / 100.0  # 1.0 = 100%; >1 amplifies
    if shutil.which("ffmpeg"):
        try:
            ff = subprocess.Popen(
                ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", path,
                 "-filter:a", f"volume={factor:.3f}", "-f", "wav", "pipe:1"],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            subprocess.Popen(["aplay", "-q", "-"], stdin=ff.stdout,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            ff.stdout.close()  # aplay owns the read end; ffmpeg SIGPIPEs when done
            return
        except OSError:
            pass
    # Fallbacks: paplay scales volume (and can exceed 100%), then plain aplay.
    try:
        pa_vol = max(0, min(65536 * 4, int(65536 * factor)))
        subprocess.Popen(["paplay", f"--volume={pa_vol}", path],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return
    except (OSError, ValueError):
        pass
    try:
        subprocess.Popen(["aplay", "-q", path],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError as e:
        log.warning("audio playback failed (no ffmpeg/paplay/aplay?): %s", e)


def play(category: str) -> None:
    """Play a category's sound if that category is enabled. Debounced; never raises."""
    try:
        if category not in CATEGORIES or not _category_enabled(category):
            return
        now = time.monotonic()
        last = _last_played.get(category)
        if last is not None and (now - last) < DEBOUNCE_SEC:
            return
        _last_played[category] = now
        _play_file(_category_sound(category), _get_int(KEY_VOLUME, VOLUME_DEFAULT, 0, VOLUME_MAX))
    except Exception as e:  # pragma: no cover - audio must never break a caller
        log.warning("audio play(%s) failed: %s", category, e)


def category_for(kind: Optional[str], detail: Optional[str] = None) -> Optional[str]:
    """Map a system event (kind + optional severity in detail) to a category.
    critical→error, warning→alert, info/success→info."""
    k = (kind or "").lower()
    d = (detail or "").lower()
    if k == "error" or d == "critical":
        return "error"
    if k == "alert":
        return "error" if d == "critical" else "alert"
    if k == "warning" or d == "warning":
        return "alert"
    if k in ("info", "success"):
        return "info"
    return None


def on_event(kind: Optional[str], detail: Optional[str] = None) -> None:
    """Hook for system_events.emit(): play the mapped category's sound."""
    cat = category_for(kind, detail)
    if cat:
        play(cat)


# ---------------------------------------------------------------------------
# Config + upload + test endpoints (/config → Settings → Audio)
# ---------------------------------------------------------------------------

@router.get("/config")
def get_audio_config() -> dict:
    return {
        "categories": [
            {
                "id": c,
                "label": c.capitalize(),
                "sound_file": _category_sound(c),
                "enabled": _category_enabled(c),
                "default": DEFAULT_FILE[c],
            }
            for c in CATEGORIES
        ],
        "volume_pct": _get_int(KEY_VOLUME, VOLUME_DEFAULT, 0, VOLUME_MAX),
        "volume_max": VOLUME_MAX,
        "sounds": [SOUND_NONE, *list_sounds()],
        "allowed_ext": sorted(ALLOWED_EXT),
    }


class CategoryCfg(BaseModel):
    sound_file: str = Field(min_length=1, max_length=120)
    enabled: bool


class AudioConfigRequest(BaseModel):
    error: CategoryCfg
    alert: CategoryCfg
    info: CategoryCfg
    volume_pct: int = Field(ge=0, le=VOLUME_MAX)


@router.post("/config")
def set_audio_config(body: AudioConfigRequest) -> dict:
    from app.settings import _persist_setting  # noqa: PLC0415

    known = set(list_sounds())
    cfg = {"error": body.error, "alert": body.alert, "info": body.info}
    for cat, c in cfg.items():
        if c.sound_file != SOUND_NONE and c.sound_file not in known:
            raise HTTPException(status_code=400, detail=f"unknown sound file for {cat}")
    ok = _persist_setting(KEY_VOLUME, str(int(body.volume_pct)))
    for cat, c in cfg.items():
        ok = _persist_setting(KEY_FILE[cat], c.sound_file) and ok
        ok = _persist_setting(KEY_ENABLE[cat], "1" if c.enabled else "0") and ok
    if not ok:
        raise HTTPException(status_code=500, detail="failed to persist audio config")
    return get_audio_config()


@router.post("/upload")
async def upload_sound(file: UploadFile = File(...)) -> dict:
    """Accept a .wav/.mp3/.ogg upload; transcode non-WAV to WAV (ffmpeg) so
    playback stays paplay/aplay-simple. Stored in SOUNDS_DIR; appears in the
    dropdowns immediately."""
    stem, ext = os.path.splitext(os.path.basename(file.filename or ""))
    ext = ext.lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(status_code=400, detail=f"unsupported type {ext!r}; allowed: {sorted(ALLOWED_EXT)}")
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail=f"file too large (max {MAX_UPLOAD_BYTES // (1024*1024)} MB)")
    if not data:
        raise HTTPException(status_code=400, detail="empty file")
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", stem)[:60] or "sound"
    try:
        os.makedirs(SOUNDS_DIR, exist_ok=True)
        dest = os.path.join(SOUNDS_DIR, safe + ".wav")
        if ext == ".wav":
            with open(dest, "wb") as fh:
                fh.write(data)
        else:
            if not shutil.which("ffmpeg"):
                raise HTTPException(status_code=400, detail="ffmpeg not installed; upload a .wav instead")
            tmp = os.path.join(SOUNDS_DIR, f".upload-{safe}{ext}")
            with open(tmp, "wb") as fh:
                fh.write(data)
            try:
                subprocess.run(["ffmpeg", "-y", "-i", tmp, dest],
                               capture_output=True, timeout=FFMPEG_TIMEOUT, check=True)
            except (subprocess.SubprocessError, OSError) as e:
                raise HTTPException(status_code=400, detail=f"could not convert audio: {e}")
            finally:
                try:
                    os.remove(tmp)
                except OSError:
                    pass
    except HTTPException:
        raise
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"could not save upload: {e}")
    return {"ok": True, "file": os.path.basename(dest), "sounds": [SOUND_NONE, *list_sounds()]}


class TestRequest(BaseModel):
    category: str


@router.post("/test")
def test_audio(body: TestRequest) -> dict:
    """Preview a category's sound on the Pi speaker (plays regardless of the
    category's enable toggle — it's an explicit test)."""
    if body.category not in CATEGORIES:
        raise HTTPException(status_code=400, detail="unknown category")
    _play_file(_category_sound(body.category), _get_int(KEY_VOLUME, VOLUME_DEFAULT, 0, VOLUME_MAX))
    return {"ok": True}
