# Stack-light notifications — multicast bridge (foundation)

**Date:** 2026-06-20
**Status:** Approved; foundation slice implemented (event hooks are a later pass).

## Goal

Bridge StackPI events (bad-tag alerts, reader traffic-light status) to networked
stack lights / buzzers by sending JSON notification messages over UDP multicast.
This slice delivers the **schema + notifier + a `/config` test page**; wiring the
actual event sources is a separate pass.

## Wire format (UTF-8 JSON, one datagram)

```jsonc
// light
{ "v":1, "type":"light",
  "pattern":"solid|flash|pulse", "color":"red|green|yellow|blue",
  "brightness":0-100, "duration":<ms>, "repeat_count":1-5 }
// sound
{ "v":1, "type":"sound",
  "sound":"<name>", "volume":0-100, "duration":<ms>, "repeat_count":1-5 }
```

`v` is the schema version. `duration` is on-time (solid) or cycle period (ms);
`repeat_count` is cycles (1–5).

## Components

### `api/app/notifier.py`
- Pydantic `LightMessage` / `SoundMessage` (range-validated) reused by senders
  AND the test routes.
- `_emit(payload)` — best-effort UDP multicast `sendto` (sets
  `IP_MULTICAST_TTL=1`), logs + returns False on error, never raises.
- `send_light(msg)` / `send_sound(msg)` — honor the enable flag, then `_emit`
  (these are what the future event hooks call).
- Settings in `local_app_settings`: `notify_enable`, `notify_multicast_group`
  (default `239.10.10.10`), `notify_multicast_port` (default `5005`).
- Router `/local/notify`: `GET/POST /config` (POST validates the group is IPv4
  multicast), `POST /test/light`, `POST /test/sound` (these always fire, so a
  test works regardless of the enable flag; they return the sent payload).
- Registered in `main.py`.

### `/config → Settings → Notifications` (`settings/notifications/page.tsx`)
- Multicast group + port + enable toggle (Save).
- Test-light form (pattern/color/brightness/duration/repeat) and test-sound form
  (sound/volume/duration/repeat), each with a Send button + result (shows the
  sent JSON). Sidebar entry under Settings.

## Testing / verification

- `test_notifier.py` (11 tests): payload shape, enable gating, `_emit` builds the
  right datagram + swallows errors, test endpoints, validation → 422, config
  GET/POST incl. non-multicast → 400.
- Real transport verified locally: a multicast listener received the exact JSON
  datagram from `_emit`.

## Next pass (separate)

Wire `alerts.fire()` → red-flash light + alert sound; the reader-status poll →
light on state change (red/yellow/blue/green), using the hardcoded mapping.
Possibly periodic re-send (UDP is lossy) and respect `stacklight_enable`
(3- vs 4-color).
