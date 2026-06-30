# Automatic timezone detection + pool.ntp.org default

**Date:** 2026-06-29
**Status:** Approved, pending implementation plan

## Problem

The kiosk's timezone must be set by hand on the System settings page; a device
shipped to a new location shows the wrong local time until someone fixes it.
We want the timezone to set itself automatically from the device's internet
location at boot (and whenever the internet finally becomes reachable), with a
manual override. Separately, the NTP default should be `pool.ntp.org` rather
than the distro's Debian pool.

## Current state

- Timezone: `POST /local/settings/time/timezone` → privileged helper
  `set-timezone` → `timedatectl set-timezone` (validates against
  `timedatectl list-timezones`). No auto-detection.
- NTP: `set-ntp-servers` writes `/etc/systemd/timesyncd.conf.d/stackpi.conf`;
  zero args **removes** the drop-in, falling back to systemd's Debian pool.
- `GET /local/settings/time` returns `{timezone, ntp_active, ntp_servers_override, ...}`.
- The API already starts background asyncio tasks at startup (e.g.
  `status_broadcast.start()`), and `_run_helper` invokes the privileged helper.

## Decisions (locked)

- **Explicit "Automatic" toggle, default ON** (`timezone_auto`). Manual timezone
  set turns it OFF; re-enabling resumes auto and detects immediately.
- **Detection runs as an API background task** (same pattern as the status
  broadcaster) — no new systemd units.
- **Geo-IP service:** `https://ipapi.co/timezone/` (HTTPS, returns the plain
  IANA zone, free, no key). Fail-safe: any error skips the cycle.
- **NTP default = `pool.ntp.org`.**

## Design

### 1. The `timezone_auto` setting

A boolean in `local_app_settings` (key `timezone_auto`), default true, read/written
with the existing settings helpers. If lost to a power-cut-before-snapshot it
falls back to the default (true) — the desired default, so no durability work.

### 2. Auto-detection background task (`api/app/tz_auto.py`)

Started/stopped from the API lifespan alongside `status_broadcast`. Loop:

1. If `timezone_auto` is false → sleep and continue (no detection while overridden).
2. GET `https://ipapi.co/timezone/` (short timeout, no redirects). On any
   exception / non-200 / empty / non-IANA-looking body → treat as "offline",
   skip this cycle.
3. If the detected zone differs from the current (`timedatectl`/helper) zone →
   apply via `_run_helper("set-timezone", zone)` (the helper validates the zone,
   so a bad value is rejected, not applied). Log the change.
4. Cadence: retry every **120 s** until a cycle reaches the geo-IP service
   successfully (covers boot + "finally connected"); after a successful reach,
   re-check every **6 h** (handles a relocated device). A failed reach keeps the
   120 s cadence.

Pure helpers are factored out so they unit-test without the network or root:
- `_detect_timezone(get_fn) -> Optional[str]` — parse/validate the geo-IP body.
- `_should_apply(detected, current) -> bool` — apply only on a real change.

### 3. API changes (`api/app/settings.py`)

- `GET /local/settings/time` adds `timezone_auto: bool`.
- `POST /local/settings/time/timezone` (manual set) also sets
  `timezone_auto = false` (this manual zone is the override).
- New `POST /local/settings/time/timezone-auto` `{enabled: bool}` → persist the
  flag; when enabling, kick an immediate detect+apply (best-effort).

### 4. NTP default = pool.ntp.org

- `deploy/scripts/stackpi-settings-helper.sh`: `set-ntp-servers` with **zero
  args** writes the drop-in with `NTP=pool.ntp.org` (instead of removing it), so
  "clear override" resets to the intended default.
- `deploy/install.sh`: seed `/etc/systemd/timesyncd.conf.d/stackpi.conf` with
  `NTP=pool.ntp.org` on install if absent, and restart `systemd-timesyncd`, so
  fresh devices use it from first boot.
- The API/UI treat `pool.ntp.org` as the default; a custom override is unchanged.

### 5. Frontend (`portal/src/app/config/settings/system/page.tsx`)

- An **"Automatic timezone (from internet location)"** toggle bound to
  `timezone_auto` (`POST /local/settings/time/timezone-auto`). The active zone is
  shown.
- The existing timezone field is the manual **override**: editable always;
  saving it (existing `POST .../time/timezone`) turns Automatic off.
- The NTP section shows `pool.ntp.org` as the default (placeholder / helper
  text); the override input is unchanged.

## Error handling

- No internet / geo-IP failure → skip the cycle, retry on cadence; never crash
  the loop (broad except, log + sleep), mirroring `status_broadcast._run`.
- Invalid zone from geo-IP → rejected by the `set-timezone` helper; logged, not
  applied.
- Helper failure → logged; the loop continues.

## Testing

- `tz_auto`: `_detect_timezone` (valid zone, empty body, junk body, HTTP error →
  None) and `_should_apply` (changed → true, same/None → false) with the
  HTTP getter injected; the apply path with `_run_helper` mocked.
- `settings`: `GET /time` includes `timezone_auto`; manual `POST /time/timezone`
  sets the flag false; `POST /time/timezone-auto` persists and (when enabling)
  triggers a detect. psql/helper mocked; functions called directly (no
  TestClient).
- Shell/systemd (`set-ntp-servers` default, install seed) — manual verification
  on the Pi, noted in the plan.

## Out of scope

- Detecting timezone from anything other than public-IP geolocation.
- Changing how NTP sync itself works (still systemd-timesyncd).
- Per-move/per-site timezone logic.
