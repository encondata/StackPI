# Automatic Timezone + pool.ntp.org Default — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-set the kiosk timezone from its internet location at boot / when first online (with a manual override toggle), and make `pool.ntp.org` the standing NTP default.

**Architecture:** A background asyncio task in the API (like the status broadcaster) polls a geo-IP service and applies the timezone via the existing privileged helper, gated by a `timezone_auto` setting. Settings endpoints expose/toggle the flag. The settings helper + install seed `pool.ntp.org` as the NTP default. The System settings page gets an Automatic toggle.

**Tech Stack:** Python 3.13 / FastAPI / `requests` / pytest (API); bash + systemd-timesyncd (deploy); Next 16 / React 19 / TypeScript (portal).

## Global Constraints

- Geo-IP service: `https://ipapi.co/timezone/` (HTTPS, plain IANA zone body, no key); any error/non-200/non-IANA body → skip the cycle (fail-safe).
- Timezone is applied ONLY via the existing `_run_helper("set-timezone", zone)` (validates against `timedatectl list-timezones`); never write timedatectl directly from Python.
- `timezone_auto` is a `local_app_settings` bool stored as `"1"`/`"0"`, default `"1"` (on). A manual timezone set turns it off.
- Cadence: retry every 120 s until the geo-IP service is reached, then every 21600 s (6 h).
- NTP default is `pool.ntp.org`; a custom override still works as today.
- API tests import modules directly and monkeypatch (no FastAPI TestClient — avoids python-multipart). Portal gate is `tsc` (single run, no concurrent runs).
- Spec: `docs/superpowers/specs/2026-06-29-auto-timezone-ntp-default-design.md`.

---

### Task 1: `timezone_auto` setting + `tz_auto` detection module

**Files:**
- Modify: `api/app/settings.py` (add the setting helpers near the other `_get_setting_*` ~line 524)
- Create: `api/app/tz_auto.py`
- Test: `api/tests/test_tz_auto.py`

**Interfaces:**
- Produces in `settings.py`: `TIMEZONE_AUTO_KEY = "timezone_auto"`, `get_timezone_auto() -> bool`, `set_timezone_auto(enabled: bool) -> bool`.
- Produces in `tz_auto.py`: `_detect_timezone(get_fn) -> Optional[str]`, `_should_apply(detected, current) -> bool`, `apply_once() -> Optional[str]`, `start() -> asyncio.Task`, `stop(task)`, and module constants `GEOIP_URL`, `FAST_RETRY_SEC`, `SLOW_RECHECK_SEC`.

- [ ] **Step 1: Write the failing tests**

```python
# api/tests/test_tz_auto.py
"""Geo-IP timezone detection helpers and one-shot apply."""
import requests

from app import tz_auto


class _Resp:
    def __init__(self, status_code, text):
        self.status_code = status_code
        self.text = text


def test_detect_valid_zone():
    assert tz_auto._detect_timezone(lambda: _Resp(200, "America/Chicago\n")) == "America/Chicago"


def test_detect_http_error_is_none():
    assert tz_auto._detect_timezone(lambda: _Resp(500, "oops")) is None


def test_detect_junk_body_is_none():
    assert tz_auto._detect_timezone(lambda: _Resp(200, "not a zone!!")) is None


def test_detect_request_exception_is_none():
    def boom():
        raise requests.exceptions.ConnectionError("offline")
    assert tz_auto._detect_timezone(boom) is None


def test_should_apply():
    assert tz_auto._should_apply("America/Chicago", "UTC") is True
    assert tz_auto._should_apply("UTC", "UTC") is False
    assert tz_auto._should_apply(None, "UTC") is False


def test_apply_once_applies_on_change(monkeypatch):
    monkeypatch.setattr(tz_auto, "get_timezone_auto", lambda: True)
    monkeypatch.setattr(tz_auto, "_detect_timezone", lambda get_fn: "America/Chicago")
    monkeypatch.setattr(tz_auto, "_current_timezone", lambda: "UTC")
    applied = {}
    monkeypatch.setattr(tz_auto, "_apply", lambda z: applied.setdefault("z", z) or True)
    assert tz_auto.apply_once() == "America/Chicago"
    assert applied["z"] == "America/Chicago"


def test_apply_once_skips_when_disabled(monkeypatch):
    monkeypatch.setattr(tz_auto, "get_timezone_auto", lambda: False)
    called = {"n": 0}
    monkeypatch.setattr(tz_auto, "_detect_timezone", lambda get_fn: called.__setitem__("n", called["n"] + 1) or "X")
    assert tz_auto.apply_once() is None
    assert called["n"] == 0  # geo-IP not queried while overridden


def test_apply_once_reached_but_no_change(monkeypatch):
    monkeypatch.setattr(tz_auto, "get_timezone_auto", lambda: True)
    monkeypatch.setattr(tz_auto, "_detect_timezone", lambda get_fn: "UTC")
    monkeypatch.setattr(tz_auto, "_current_timezone", lambda: "UTC")
    monkeypatch.setattr(tz_auto, "_apply", lambda z: (_ for _ in ()).throw(AssertionError("should not apply")))
    assert tz_auto.apply_once() == "UTC"  # reached service, nothing applied
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && .venv/bin/python -m pytest tests/test_tz_auto.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.tz_auto'`.

- [ ] **Step 3: Add the setting helpers to `settings.py`**

Near the other `_get_setting_*` helpers in `api/app/settings.py`:

```python
TIMEZONE_AUTO_KEY = "timezone_auto"


def get_timezone_auto() -> bool:
    """Whether the timezone is auto-detected from the device location (on by
    default). A manual timezone set turns this off."""
    return _get_setting_str(TIMEZONE_AUTO_KEY, "1") == "1"


def set_timezone_auto(enabled: bool) -> bool:
    return _persist_setting(TIMEZONE_AUTO_KEY, "1" if enabled else "0")
```

- [ ] **Step 4: Create `api/app/tz_auto.py`**

```python
"""Set the timezone from the device's internet location.

When the `timezone_auto` setting is on, periodically ask a geo-IP service for
the device's IANA timezone and apply it via the privileged set-timezone helper
(which validates the zone). Off while the operator has set a manual override.
Started as a background task by the API lifespan, like status_broadcast.
"""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Callable, Optional

import requests

from app.settings import _run_helper, get_timezone_auto

log = logging.getLogger("stackpi.tz_auto")

GEOIP_URL = "https://ipapi.co/timezone/"
GEOIP_TIMEOUT_SEC = 8.0
FAST_RETRY_SEC = 120.0       # until the geo-IP service is first reached
SLOW_RECHECK_SEC = 21600.0   # 6h once online (handles a relocated device)

_TZ_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_+-]*(?:/[A-Za-z0-9_+-]+)*$")


def _detect_timezone(get_fn: Callable[[], "requests.Response"]) -> Optional[str]:
    """The IANA timezone from the geo-IP service, or None on any error /
    unreachable / non-IANA body."""
    try:
        resp = get_fn()
    except requests.RequestException:
        return None
    if resp.status_code != 200:
        return None
    zone = (resp.text or "").strip()
    return zone if _TZ_RE.match(zone) else None


def _should_apply(detected: Optional[str], current: Optional[str]) -> bool:
    return bool(detected) and detected != current


def _current_timezone() -> Optional[str]:
    try:
        return (_run_helper("get-timezone") or "").strip() or None
    except Exception:
        return None


def _apply(zone: str) -> bool:
    try:
        _run_helper("set-timezone", zone)
        return True
    except Exception as e:  # noqa: BLE001
        log.warning("tz_auto: set-timezone %s failed: %s", zone, e)
        return False


def apply_once() -> Optional[str]:
    """One detect+apply pass. Returns the detected zone if the geo-IP service
    was reached (whether or not a change was applied), or None if auto is off
    or the service is unreachable."""
    if not get_timezone_auto():
        return None
    detected = _detect_timezone(
        lambda: requests.get(GEOIP_URL, timeout=GEOIP_TIMEOUT_SEC, allow_redirects=False)
    )
    if detected is None:
        return None
    if _should_apply(detected, _current_timezone()) and _apply(detected):
        log.info("tz_auto: timezone set to %s", detected)
    return detected


async def _run() -> None:
    log.info("tz_auto started")
    loop = asyncio.get_event_loop()
    while True:
        try:
            reached = await loop.run_in_executor(None, apply_once)
            delay = SLOW_RECHECK_SEC if reached is not None else FAST_RETRY_SEC
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - the loop must never die
            log.warning("tz_auto cycle failed: %s", e)
            delay = FAST_RETRY_SEC
        await asyncio.sleep(delay)


def start() -> "asyncio.Task":
    return asyncio.get_event_loop().create_task(_run())


async def stop(task: "Optional[asyncio.Task]") -> None:
    if task is None:
        return
    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, Exception):  # noqa: BLE001
        pass
```

- [ ] **Step 4b: Run tests to verify they pass**

Run: `cd api && .venv/bin/python -m pytest tests/test_tz_auto.py -q`
Expected: PASS (8 passed).

- [ ] **Step 5: Commit**

```bash
git add api/app/settings.py api/app/tz_auto.py api/tests/test_tz_auto.py
git commit -m "feat(time): geo-IP timezone detection module + timezone_auto setting"
```

---

### Task 2: Wire endpoints + lifespan

**Files:**
- Modify: `api/app/settings.py` (`get_time_status` ~line 756; `set_timezone` ~line 772; add `TimezoneAutoRequest` model + `POST /time/timezone-auto`)
- Modify: `api/app/main.py` (lifespan ~lines 25-34)
- Test: `api/tests/test_time_auto_endpoints.py`

**Interfaces:**
- Consumes: `get_timezone_auto`/`set_timezone_auto` (Task 1), `tz_auto.apply_once`/`start`/`stop` (Task 1).
- Produces: `GET /local/settings/time` includes `timezone_auto`; manual `POST /local/settings/time/timezone` sets it false; `POST /local/settings/time/timezone-auto {enabled}`.

- [ ] **Step 1: Write the failing tests**

```python
# api/tests/test_time_auto_endpoints.py
from app import settings as s


def test_get_time_includes_timezone_auto(monkeypatch):
    monkeypatch.setattr(s, "_run_helper", lambda *a, **k: "timezone=UTC\n" if a[0] == "get-time-status" else "")
    monkeypatch.setattr(s, "get_timezone_auto", lambda: True)
    out = s.get_time_status()
    assert out["timezone_auto"] is True


def test_manual_timezone_set_disables_auto(monkeypatch):
    seen = {}
    monkeypatch.setattr(s, "_run_helper", lambda *a, **k: "timezone=America/Chicago\n" if a[0] == "get-time-status" else "")
    monkeypatch.setattr(s, "set_timezone_auto", lambda enabled: seen.setdefault("enabled", enabled) or True)
    monkeypatch.setattr(s, "get_timezone_auto", lambda: False)
    s.set_timezone(s.TimezoneRequest(timezone="America/Chicago"))
    assert seen["enabled"] is False


def test_timezone_auto_enable_persists_and_detects(monkeypatch):
    seen = {}
    monkeypatch.setattr(s, "set_timezone_auto", lambda enabled: seen.setdefault("enabled", enabled) or True)
    import app.tz_auto as tz
    monkeypatch.setattr(tz, "apply_once", lambda: seen.setdefault("applied", True))
    monkeypatch.setattr(s, "_run_helper", lambda *a, **k: "timezone=UTC\n" if a[0] == "get-time-status" else "")
    monkeypatch.setattr(s, "get_timezone_auto", lambda: True)
    s.set_timezone_auto_route(s.TimezoneAutoRequest(enabled=True))
    assert seen["enabled"] is True and seen.get("applied") is True


def test_timezone_auto_disable_does_not_detect(monkeypatch):
    seen = {}
    monkeypatch.setattr(s, "set_timezone_auto", lambda enabled: seen.setdefault("enabled", enabled) or True)
    import app.tz_auto as tz
    monkeypatch.setattr(tz, "apply_once", lambda: seen.setdefault("applied", True))
    monkeypatch.setattr(s, "_run_helper", lambda *a, **k: "timezone=UTC\n" if a[0] == "get-time-status" else "")
    monkeypatch.setattr(s, "get_timezone_auto", lambda: False)
    s.set_timezone_auto_route(s.TimezoneAutoRequest(enabled=False))
    assert seen["enabled"] is False and "applied" not in seen
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && .venv/bin/python -m pytest tests/test_time_auto_endpoints.py -q`
Expected: FAIL — `AttributeError`/`KeyError` (`timezone_auto`, `TimezoneAutoRequest`, `set_timezone_auto_route` missing).

- [ ] **Step 3: Add `timezone_auto` to `get_time_status`**

In `get_time_status`, add the key to the returned dict:

```python
        "ntp_servers_override": servers,  # empty list = using defaults
        "timezone_auto": get_timezone_auto(),
    }
```

- [ ] **Step 4: Turn off auto on a manual timezone set**

In `set_timezone`, after the successful `_run_helper("set-timezone", tz)` and before `return get_time_status()`:

```python
    _run_helper("set-timezone", tz)
    set_timezone_auto(False)  # a manual set is an override
    return get_time_status()
```

- [ ] **Step 5: Add the toggle model + route**

Near the other Time models / endpoints in `settings.py`:

```python
class TimezoneAutoRequest(BaseModel):
    enabled: bool


@router.post("/time/timezone-auto")
def set_timezone_auto_route(body: TimezoneAutoRequest) -> Dict[str, Any]:
    set_timezone_auto(body.enabled)
    if body.enabled:
        from app import tz_auto  # noqa: PLC0415
        tz_auto.apply_once()  # detect immediately on enable (best-effort)
    return get_time_status()
```

- [ ] **Step 6: Start/stop `tz_auto` in the lifespan**

In `api/app/main.py` lifespan, alongside `status_broadcast`:

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Status snapshot multicast broadcaster (5s heartbeat + on-change).
    from app import status_broadcast  # noqa: PLC0415
    from app import tz_auto  # noqa: PLC0415

    task = status_broadcast.start()
    tz_task = tz_auto.start()
    try:
        yield
    finally:
        await tz_auto.stop(tz_task)
        await status_broadcast.stop(task)
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd api && .venv/bin/python -m pytest tests/test_time_auto_endpoints.py tests/test_tz_auto.py -q`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add api/app/settings.py api/app/main.py api/tests/test_time_auto_endpoints.py
git commit -m "feat(time): timezone_auto in /time, manual-set override, lifespan task"
```

---

### Task 3: pool.ntp.org as the NTP default (deploy)

**Files:**
- Modify: `deploy/scripts/stackpi-settings-helper.sh` (`set-ntp-servers` zero-arg branch ~lines 177-184)
- Modify: `deploy/install.sh` (seed the timesyncd drop-in)

**Interfaces:** none (shell + systemd; manual verification on the Pi).

- [ ] **Step 1: Make "clear override" reset to pool.ntp.org**

In `stackpi-settings-helper.sh`, replace the zero-arg branch of `set-ntp-servers`:

```bash
    if [[ $# -eq 0 ]]; then
      rm -f "$DROPIN"
      systemctl restart systemd-timesyncd
      echo "ntp: cleared override, using defaults"
      exit 0
    fi
```

with:

```bash
    if [[ $# -eq 0 ]]; then
      # No custom override -> reset to the StackPI default (pool.ntp.org),
      # not the distro's Debian pool.
      mkdir -p "$DROPIN_DIR"
      { printf '[Time]\n'; printf 'NTP=pool.ntp.org\n'; } > "$DROPIN"
      chmod 0644 "$DROPIN"
      systemctl restart systemd-timesyncd
      echo "ntp: reset to default pool.ntp.org"
      exit 0
    fi
```

- [ ] **Step 2: Seed the default at install**

In `deploy/install.sh`, add an idempotent block where system config is set up (e.g. near the end, before the final summary). Use the exact content:

```bash
# --- NTP default: pool.ntp.org -------------------------------------------
# Seed the StackPI timesyncd drop-in so fresh devices use pool.ntp.org rather
# than the Debian pool. Skips if a drop-in already exists (operator override).
TIMESYNCD_DROPIN_DIR=/etc/systemd/timesyncd.conf.d
TIMESYNCD_DROPIN="$TIMESYNCD_DROPIN_DIR/stackpi.conf"
if [[ ! -f "$TIMESYNCD_DROPIN" ]]; then
  mkdir -p "$TIMESYNCD_DROPIN_DIR"
  { printf '[Time]\n'; printf 'NTP=pool.ntp.org\n'; } > "$TIMESYNCD_DROPIN"
  chmod 0644 "$TIMESYNCD_DROPIN"
  systemctl restart systemd-timesyncd || true
  echo "[install] seeded NTP default pool.ntp.org"
fi
```

- [ ] **Step 3: Verify the shell parses**

Run: `bash -n deploy/scripts/stackpi-settings-helper.sh && bash -n deploy/install.sh && echo OK`
Expected: `OK` (no syntax errors).

- [ ] **Step 4: Commit**

```bash
git add deploy/scripts/stackpi-settings-helper.sh deploy/install.sh
git commit -m "feat(deploy): pool.ntp.org as the NTP default (seed + clear reset)"
```

---

### Task 4: System settings page — Automatic toggle

**Files:**
- Modify: `portal/src/app/config/settings/system/page.tsx` (the `TimeStatus` type ~line 14; the Time section's Timezone block ~line 316; NTP default helper text)

**Interfaces:**
- Consumes: `GET /local/settings/time` (now includes `timezone_auto`), `POST /local/settings/time/timezone-auto {enabled}`.

- [ ] **Step 1: Add `timezone_auto` to the time type**

In the `TimeStatus`/time-state type (the object with `timezone`, `ntp_active`, `ntp_servers_override`), add:

```tsx
  timezone_auto: boolean;
```

- [ ] **Step 2: Add a save function for the toggle**

Near `saveTimezone` / `saveNtpServers`, add:

```tsx
  async function saveTimezoneAuto(enabled: boolean) {
    setBusy("timezone");
    try {
      const res = await fetch("/local/settings/time/timezone-auto", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const body = (await res.json().catch(() => null)) as { detail?: string } | null;
      if (res.ok) {
        flash("success", enabled ? "Automatic timezone enabled." : "Automatic timezone disabled.");
        await load();
      } else {
        flash("error", body?.detail ?? "Failed to update automatic timezone.");
      }
    } finally {
      setBusy(null);
    }
  }
```

- [ ] **Step 3: Render the Automatic toggle above the Timezone field**

Inside the `{/* Timezone */}` block, immediately after the `<p ...>Timezone</p>` label line, add:

```tsx
            <label className="mt-2 flex items-center gap-2 text-sm text-zinc-700">
              <input
                type="checkbox"
                checked={Boolean(time?.timezone_auto)}
                onChange={(e) => saveTimezoneAuto(e.target.checked)}
                disabled={busy !== null}
              />
              Set automatically from internet location
            </label>
```

- [ ] **Step 4: Note the NTP default in the NTP block**

Find the NTP override input's helper/placeholder text in the Time section and add a one-line note that the default is `pool.ntp.org`. If there is an existing helper `<p>` near the NTP input, append; otherwise add:

```tsx
            <p className="mt-1 text-xs text-zinc-500">
              Default: <code className="font-mono">pool.ntp.org</code>. Leave blank to use it.
            </p>
```

- [ ] **Step 5: Verify the build compiles**

Run (from `portal/`, ONE run, wait 1-2 min): `node_modules/.bin/tsc --noEmit`
Expected: no errors referencing `system/page.tsx`.

- [ ] **Step 6: Commit**

```bash
git add portal/src/app/config/settings/system/page.tsx
git commit -m "feat(config): automatic timezone toggle + NTP default note"
```

---

## Self-Review notes

- **Spec coverage:** §1 setting (Task 1) ✓; §2 detection task + helpers + cadence (Task 1) ✓; §3 endpoints + override + lifespan (Task 2) ✓; §4 NTP default seed + clear-reset (Task 3) ✓; §5 frontend toggle + NTP note (Task 4) ✓.
- **Type consistency:** `apply_once` returns the detected zone (truthy) when reached, `None` when offline/disabled — the loop reads `reached is not None` to pick the cadence; `get_time_status` key `timezone_auto` matches the TS `timezone_auto`; `TimezoneAutoRequest.enabled` matches the POST body.
- **Import safety:** `tz_auto` imports `from app.settings import _run_helper, get_timezone_auto` at module top; `settings.py` imports `tz_auto` only lazily (inside the route) and `main.py` lazily (inside lifespan), so there's no circular import at load.
- **Env caveat:** API tests import `app.settings`/`app.tz_auto` directly and monkeypatch (no TestClient). Portal gate is `tsc` (single run). Task 3 is shell — `bash -n` parse check + manual verification on the Pi.
- **Live verification (Pi):** boot with internet → timezone matches location; toggle off + set manually → sticks; toggle back on → re-detects; NTP server shows `pool.ntp.org` by default.
