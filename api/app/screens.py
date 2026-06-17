"""Screen configuration: per-display dropdown settings (default view,
screen saver timeout, current selector, QR registration overlay).

Persisted in the same local_app_settings KV table as Hardware, keyed as
  screen.<screen_id>.<setting>
"""

from typing import Dict

from fastapi import APIRouter, HTTPException

from app.settings import _psql_exec, _psql_rows

router = APIRouter(prefix="/local/screens")

# Allowed screens.
_KNOWN_SCREENS = {"info1", "info2", "touch"}

# Per-setting allowlists. POST values are checked against these *and* the row
# is INSERTed via literal substitution, so the allowlist is also our SQL-safety
# guarantee — never accept anything outside these sets.
_VALID_VALUES: Dict[str, set] = {
    "default_screen": {"clock", "status", "trucks", "cycle", "off"},
    "selector":       {"clock", "status", "trucks", "cycle", "off"},
    "saver":          {"30m", "15m", "5m", "3m", "1m", "disabled"},
    "show_qr":        {"enabled", "disabled"},
}

_INFO_KEYS = ("default_screen", "saver", "selector", "show_qr")
# The touchscreen can now be assigned a screen too (HDMI1/HDMI2/Touchscreen all
# selectable from the kiosk Config page), so it accepts default_screen/selector
# in addition to its QR toggle.
_TOUCH_KEYS = ("default_screen", "selector", "show_qr")

_DEFAULTS_INFO: Dict[str, str] = {
    "default_screen": "clock",
    "saver":          "15m",
    "selector":       "clock",
    "show_qr":        "enabled",
}
_DEFAULTS_TOUCH: Dict[str, str] = {
    "default_screen": "status",
    "selector":       "status",
    "show_qr":        "enabled",
}

# Global screen-cycle interval (seconds) — how fast a screen set to "cycle"
# rotates between the Status and Truck views. One value shared by all outputs.
SCREEN_CYCLE_KEY = "screen_cycle_seconds"
CYCLE_DEFAULT = 15
CYCLE_MIN = 3
CYCLE_MAX = 600


def _defaults_for(screen_id: str) -> Dict[str, str]:
    return dict(_DEFAULTS_TOUCH) if screen_id == "touch" else dict(_DEFAULTS_INFO)


def _read_screen(screen_id: str) -> Dict[str, str]:
    defaults = _defaults_for(screen_id)
    keys = list(defaults.keys())
    in_clause = ",".join(repr(f"screen.{screen_id}.{k}") for k in keys)
    rows = _psql_rows(
        f"SELECT key, value FROM local_app_settings WHERE key IN ({in_clause})"
    )
    out = dict(defaults)
    prefix = f"screen.{screen_id}."
    for r in rows:
        if len(r) >= 2 and r[0].startswith(prefix):
            short = r[0][len(prefix):]
            if short in out:
                out[short] = r[1]
    return out


# NOTE: literal routes must be declared BEFORE the parametric /{screen_id}
# route so Starlette matches "/cycle-seconds" as a literal, not a screen id.

@router.get("/cycle-seconds")
def get_cycle_seconds() -> Dict[str, int]:
    """Current screen-cycle interval (seconds) plus its bounds/default."""
    from app.settings import _get_setting_int  # noqa: PLC0415

    return {
        "cycle_seconds": _get_setting_int(SCREEN_CYCLE_KEY, CYCLE_DEFAULT, CYCLE_MIN, CYCLE_MAX),
        "cycle_seconds_default": CYCLE_DEFAULT,
        "cycle_seconds_min": CYCLE_MIN,
        "cycle_seconds_max": CYCLE_MAX,
    }


@router.post("/cycle-seconds")
def set_cycle_seconds(body: Dict[str, int]) -> Dict[str, int]:
    """Persist the screen-cycle interval. Clamps to [CYCLE_MIN, CYCLE_MAX]."""
    from app.settings import _persist_setting  # noqa: PLC0415

    raw = body.get("cycle_seconds")
    try:
        value = int(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        raise HTTPException(400, "cycle_seconds must be an integer")
    clamped = max(CYCLE_MIN, min(CYCLE_MAX, value))
    if not _persist_setting(SCREEN_CYCLE_KEY, str(clamped)):
        raise HTTPException(500, "failed to persist cycle_seconds")
    return get_cycle_seconds()


@router.get("/{screen_id}")
def get_screen(screen_id: str) -> Dict[str, str]:
    if screen_id not in _KNOWN_SCREENS:
        raise HTTPException(404, f"unknown screen_id: {screen_id}")
    return _read_screen(screen_id)


@router.post("/{screen_id}")
def set_screen(screen_id: str, body: Dict[str, str]) -> Dict[str, str]:
    if screen_id not in _KNOWN_SCREENS:
        raise HTTPException(404, f"unknown screen_id: {screen_id}")

    allowed_keys = _TOUCH_KEYS if screen_id == "touch" else _INFO_KEYS

    # Validate every incoming field against the allowlist before touching SQL.
    for key, value in body.items():
        if key not in allowed_keys:
            raise HTTPException(400, f"unknown key for {screen_id}: {key}")
        if not isinstance(value, str) or value not in _VALID_VALUES[key]:
            raise HTTPException(400, f"invalid value for {key}: {value!r}")

    for key, value in body.items():
        sql = (
            "INSERT INTO local_app_settings (key, value) "
            f"VALUES ('screen.{screen_id}.{key}', '{value}') "
            "ON CONFLICT (key) DO UPDATE "
            "SET value = EXCLUDED.value, updated_at = NOW()"
        )
        if not _psql_exec(sql):
            raise HTTPException(500, f"failed to persist {key}")

    return _read_screen(screen_id)
