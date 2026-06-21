# ESP32 stack-light / speaker controller — firmware design

**Date:** 2026-06-21
**Status:** Approved design, pre-implementation
**Module:** `esp_stacklight` (part of StackPI_v2)

## 1. Purpose

Firmware for an ESP32-based controller that receives StackPI notifications over
UDP multicast and drives a 4-color LED stack light plus a speaker. One-way,
best-effort. The wire protocol is already defined in
[`notification-protocol.md`](../../../notification-protocol.md) — this firmware
is a conforming receiver. Source of truth for the protocol stays that document;
this spec covers only the device implementation.

## 2. Hardware

| Block | Part | Role |
|---|---|---|
| MCU | ESP-WROOM-32 dev board | WiFi, multicast receive, drives everything |
| Lamps | 4-channel MOSFET board (3.7–27V, 10A/ch, PWM-capable) | Switches the 4 stack-light colors |
| Stack light | 24V DC LED tower, 4 colors (red / green / yellow / blue) | Visual notification + status indication |
| Audio | MAX98357A (I2S DAC + class-D amp) + speaker | `sound` notifications |
| Power | 24V supply for lamps; 5V (USB or 24V→5V buck) for ESP + amp | — |

### Pin map (kept in `config.h`, easy to change)

| Function | GPIO | Notes |
|---|---|---|
| Lamp RED → MOSFET IN1 | 16 | LEDC PWM channel |
| Lamp GREEN → MOSFET IN2 | 17 | LEDC PWM channel |
| Lamp YELLOW → MOSFET IN3 | 18 | LEDC PWM channel |
| Lamp BLUE → MOSFET IN4 | 19 | LEDC PWM channel |
| I2S BCLK | 27 | MAX98357A BCLK |
| I2S LRC / WS | 26 | MAX98357A LRC |
| I2S DIN | 25 | MAX98357A DIN |

- Strapping/flash pins (0, 2, 6–11, 12, 15) and input-only pins (34–39) avoided.
- **Common ground** required between ESP, MOSFET board, and 24V supply.
- MAX98357A SD pin tied high (always enabled); 3.3V logic drives I2S fine.

## 3. Framework & build

- **Arduino-ESP32 core via PlatformIO**, platform pinned to `espressif32@7.0.1`
  (provides the Arduino-ESP32 **2.x** core the firmware is built and verified
  against). Pinned for reproducibility so a future build cannot silently float
  to the 3.x core, which has incompatible LEDC and I2S APIs.
- Libraries: WiFiManager (captive portal + custom params), ArduinoJson (parse),
  LittleFS (WAV storage), the bundled `I2S.h` / `I2SClass` (Philips mode) for
  audio, LEDC (channel-based API) for PWM.
- LittleFS data image (`data/`) holds the WAV clips, flashed separately.

## 4. Architecture

Six focused modules, dual-core. Network + lamps + protocol run on the main loop
(core 1); audio playback runs in its own FreeRTOS task (core 0) so streaming a
WAV never stalls lamp animation or packet handling.

```
loop (core 1):  net.poll() -> protocol.handle() -> lamps.update()
audio task (core 0):  blocks on queue -> streams WAV via I2S
```

### 4.1 `config`
- Compile-time defaults: multicast group `239.10.10.10`, port `5005`, pin map.
- Runtime-overridable + NVS-persisted: multicast group, port (set via the
  WiFiManager config page).
- Exposes a settings struct loaded at boot.

### 4.2 `net`
- WiFiManager: on first boot or when saved WiFi fails to connect, host an AP +
  captive config page. Config page has standard SSID/password plus **custom
  fields for multicast group and port**, saved to NVS.
- **Default Wi-Fi**: on first boot (no operator-saved creds) the firmware
  preloads a factory-default network (`DEFAULT_WIFI_SSID` / `DEFAULT_WIFI_PASS`
  in `config.h`) so the device joins it without opening the portal. Once an
  operator saves creds via the portal, those persist and take priority.
- After connect: join the UDP multicast group on the configured port.
- `poll()` — non-blocking; returns the next datagram (≤512 bytes) or nothing.
- Tracks link state and surfaces it for status indication (section 7).

### 4.3 `protocol`
- Parse datagram as JSON (ArduinoJson).
- Ignore if not valid JSON, if `v != 1`, or if `type` is not `light`/`sound`.
- Validate + **defensively clamp** every field to the protocol's documented
  ranges, even though the sender validates.
- Dispatch to `lamps` (light) or enqueue to `audio` (sound).
- Unrecognized optional fields ignored (forward-compatible).
- Pure logic — no hardware calls — so it is unit-testable natively.

### 4.4 `lamps`
- 4 independent per-color state machines over LEDC PWM.
- **Additive / independent**: a `light` message affects only its own color; other
  colors are untouched.
- Patterns:
  - `solid` — on at `brightness` until changed. `brightness:0` → off.
  - `flash` — square wave, period = `duration`, for `repeat_count` cycles, then
    **off**.
  - `pulse` — smooth PWM fade up/down, period = `duration`, `repeat_count`
    cycles, then **off**.
- Idempotent: re-applying the same message holds/continues the same state.
- Non-blocking `update()` advances all animations from `millis()`.
- Pure-ish state machine (PWM writes behind a thin HAL) → unit-testable natively.

### 4.5 `audio`
- I2S driver for MAX98357A; runs a FreeRTOS task fed by a queue.
- WAV clips in LittleFS `data/` (e.g. `alert.wav`, `error.wav`, `info.wav`).
  Format: **16-bit PCM mono**; sample rate read from each file's header.
- `sound` identifier → filename lookup. Unknown identifier or missing file →
  ignored (logged), never errors.
- `volume` (0–100) scales samples; `repeat_count` replays the clip.
- A new `sound` message preempts the current playback (latest wins).
- **Boot chime**: `setup()` enqueues `BOOT_SOUND_ID` (`alert`) once at startup;
  the core-0 audio task plays it while `net_begin()` connects. Ignored if the
  WAV is missing.
- Independent from lamps.

### 4.6 `main`
- `setup()` — init config/NVS, LittleFS, lamps (PWM), audio task, play boot
  chime, net (WiFi + multicast).
- `loop()` — `net.poll()` → `protocol.handle()` → `lamps.update()`.

## 5. Lamp behavior summary (additive, independent)

| Pattern | While running | After `repeat_count` | `brightness:0` |
|---|---|---|---|
| solid | on at brightness | (n/a — holds) | off |
| flash | on/off square wave | off | off |
| pulse | fade up/down | off | off |

A color stays in its last state until a new message for that color arrives.
There is no global "off" — turning a color off is `brightness:0` for that color.

## 6. Audio behavior summary

| Field | Effect |
|---|---|
| `sound` | identifier → WAV file; unknown/missing → ignored |
| `volume` 0–100 | sample scaling |
| `duration` | informational; clip length comes from the file |
| `repeat_count` 1–5 | number of plays |

New `sound` preempts current playback.

## 7. Status indication (via the stack light itself)

No onboard status LED — the stack light shows device state. These only run
before/around connection, so they never collide with live notifications (once
connected and idle, all lamps are off, driven only by messages).

| State | Stack light |
|---|---|
| Config portal active (needs WiFi setup) | blue slow flash |
| WiFi connecting | yellow pulse |
| Connected / ready | green solid ~1s, then clear |
| WiFi dropped (was connected) | red flash until reconnect |

## 8. Protocol conformance & resilience

- Forward-compatible: unknown `type` / `v` / fields ignored, never error.
- Best-effort UDP: no ACK, no retransmit. On packet loss, hold last state;
  StackPI's periodic re-sends self-heal.
- Idempotent and latest-wins per channel (light vs sound independent).
- Defensive clamping of all fields.

## 9. Repo layout

```
esp_stacklight/
  platformio.ini
  src/
    main.cpp
    config.h        config.cpp
    net.h           net.cpp
    protocol.h      protocol.cpp
    lamps.h         lamps.cpp
    audio.h         audio.cpp
  data/                       # LittleFS image
    alert.wav  error.wav  info.wav
  test/                       # native (host) unit tests
    test_protocol/            # parse, version gate, clamp, dispatch
    test_lamps/               # state machine: solid/flash/pulse, brightness:0, end-off
  docs/superpowers/specs/2026-06-21-esp-stacklight-firmware-design.md
  notification-protocol.md    # existing — protocol source of truth
  README.md                   # existing
```

## 10. Testing strategy

- **Native unit tests** (PlatformIO `native` env, no hardware):
  - `protocol`: valid/invalid JSON, `v` gate, unknown `type`, clamping, dispatch.
  - `lamps`: each pattern's progression, `repeat_count` → end-off, `brightness:0`
    → off, idempotency, additive independence between colors.
- **On-device verification**: WiFi connect + captive portal, multicast join,
  end-to-end light + sound from StackPI's `/config` test buttons, status
  patterns.

## 11. Decisions locked during brainstorming

- Framework: Arduino (PlatformIO).
- Stack light: 24V LED tower, 4 colors.
- Audio: WAV files in LittleFS (16-bit mono).
- Config: WiFiManager captive portal, group/port persisted to NVS.
- Lamp logic: additive/independent; `brightness:0` = off; flash/pulse end off.
- Status: shown on the stack light, not a separate LED.

## 12. Out of scope (YAGNI)

- No web UI beyond the WiFiManager config page.
- No OTA updates (can be added later).
- No on-device WAV upload UI (clips ship in the LittleFS image).
- No ACK/telemetry back to StackPI (protocol is one-way).
