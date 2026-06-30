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
