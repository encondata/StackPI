# ESP32 Stack-Light / Speaker Controller — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Firmware for an ESP32 that receives StackPI's UDP-multicast JSON notifications and drives a 24V 4-color LED stack light (via a 4-ch MOSFET board) and a speaker (via MAX98357A).

**Architecture:** Arduino-ESP32 (PlatformIO). Pure logic (protocol parse, lamp state machine, WAV/volume, address validation) lives in Arduino-free files unit-tested on the `native` host env. Hardware wrappers (LEDC PWM, I2S audio, WiFi/multicast, NVS) wrap that logic and are verified on-device. Network + lamps run on the main loop (core 1); audio playback runs in its own FreeRTOS task (core 0).

**Tech Stack:** C++17, PlatformIO, Arduino-ESP32 core 2.x (`espressif32@7.0.1`, pinned), ArduinoJson v7, WiFiManager, LittleFS, `I2S.h`/`I2SClass`, LEDC, Preferences (NVS), Unity (tests).

> **Implementation note (2026-06-21):** The plan was authored assuming Arduino-ESP32 core 3.x (pin-based `ledcAttach`/`ledcWrite`, `ESP_I2S.h`). The installed PlatformIO platform (`espressif32@7.0.1`) resolves to the **2.x** core, so Task 4's `lamps.cpp` uses the channel-based LEDC API (`ledcSetup`/`ledcAttachPin`/`ledcWrite(channel, …)`) and Task 6's `audio.cpp` uses the bundled `<I2S.h>` / `I2SClass` (Philips mode, 16-bit mono) instead of `ESP_I2S.h`. Behavior is identical; the code on disk (source of truth) reflects the 2.x APIs and the platform is pinned. The Task 4/6 code blocks below show the original 3.x form for context.

## Global Constraints

- Protocol source of truth: `esp_stacklight/notification-protocol.md`. Schema version `v == 1`; ignore other versions, unknown `type`, and unrecognized fields (never error).
- Multicast defaults: group `239.10.10.10`, port `5005`; both operator-overridable and persisted to NVS.
- Lamp colors: `red`, `green`, `yellow`, `blue`. Patterns: `solid`, `flash`, `pulse`.
- Lamp logic: **additive/independent** per color; `brightness:0` = off; `flash`/`pulse` run `repeat_count` cycles then end **off**; `solid` holds until changed.
- Field ranges (clamp defensively): `brightness`/`volume` 0–100; `repeat_count` 1–5; `duration` ≥1 ms (upper-clamp 60000); `sound` ≤40 chars.
- Audio: 16-bit PCM mono WAV in LittleFS; unknown/missing sound → ignored; new `sound` preempts current (latest wins).
- Pin map (in `config.h`): lamps R/G/Y/B → GPIO 16/17/18/19; I2S BCLK/LRC/DIN → GPIO 27/26/25.
- **Conventions:** All `pio` commands run from `esp_stacklight/`. Git paths below are shown relative to `esp_stacklight/` (the repo root is `StackPI_v2/`, so `git` resolves them from your cwd).

---

### Task 1: Project scaffold & dual build environments

**Files:**
- Create: `platformio.ini`
- Create: `src/config.h`
- Create: `test/test_sanity/test_sanity.cpp`
- Create: `.gitignore` (append PlatformIO build dir)

**Interfaces:**
- Consumes: nothing.
- Produces: `config.h` macros (`PIN_LAMP_RED/GREEN/YELLOW/BLUE`, `PIN_I2S_BCLK/LRC/DIN`, `LEDC_FREQ_HZ`, `LEDC_RES_BITS`, `DEFAULT_MCAST_GROUP`, `DEFAULT_MCAST_PORT`, `AP_NAME`); a working `esp32dev` build env and a `native` test env with `build_src_filter` limiting native to pure files.

- [ ] **Step 1: Create `platformio.ini`**

```ini
[platformio]
default_envs = esp32dev

[env:esp32dev]
platform = espressif32
board = esp32dev
framework = arduino
monitor_speed = 115200
board_build.filesystem = littlefs
build_src_filter = +<*>
lib_deps =
  bblanchon/ArduinoJson@^7.2.0
  https://github.com/tzapu/WiFiManager.git
build_flags = -DCORE_DEBUG_LEVEL=3

[env:native]
platform = native
test_framework = unity
build_flags = -std=gnu++17
; native compiles ONLY the Arduino-free modules:
build_src_filter = +<protocol.cpp> +<lamp_state.cpp> +<wav.cpp> +<sound_map.cpp> +<net_validate.cpp>
lib_deps =
  bblanchon/ArduinoJson@^7.2.0
```

- [ ] **Step 2: Create `src/config.h`**

```cpp
#pragma once

// --- Lamp output pins (to MOSFET IN1..IN4) ---
#define PIN_LAMP_RED     16
#define PIN_LAMP_GREEN   17
#define PIN_LAMP_YELLOW  18
#define PIN_LAMP_BLUE    19

// --- I2S audio (MAX98357A) ---
#define PIN_I2S_BCLK     27
#define PIN_I2S_LRC      26
#define PIN_I2S_DIN      25

// --- LEDC PWM ---
#define LEDC_FREQ_HZ     5000
#define LEDC_RES_BITS    8        // duty 0..255

// --- Multicast defaults (operator-overridable, persisted to NVS) ---
#define DEFAULT_MCAST_GROUP "239.10.10.10"
#define DEFAULT_MCAST_PORT  5005

// --- Captive portal ---
#define AP_NAME          "StackLight-Setup"
```

- [ ] **Step 3: Create a trivial native sanity test `test/test_sanity/test_sanity.cpp`**

```cpp
#include <unity.h>

void setUp(void) {}
void tearDown(void) {}

void test_sanity(void) { TEST_ASSERT_EQUAL_INT(2, 1 + 1); }

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_sanity);
  return UNITY_END();
}
```

- [ ] **Step 4: Append PlatformIO build dir to `.gitignore`**

Add this line to `esp_stacklight/.gitignore` (create the file if absent):

```
.pio/
```

- [ ] **Step 5: Run the native sanity test to prove the toolchain works**

Run: `pio test -e native -f test_sanity`
Expected: `test_sanity ... PASSED`, `1 Tests 0 Failures`.

- [ ] **Step 6: Commit**

```bash
git add esp_stacklight/platformio.ini esp_stacklight/src/config.h esp_stacklight/test/test_sanity esp_stacklight/.gitignore
git commit -m "chore(esp_stacklight): scaffold PlatformIO project with native test env"
```

---

### Task 2: Protocol parsing (native TDD)

**Files:**
- Create: `src/protocol.h`
- Create: `src/protocol.cpp`
- Test: `test/test_protocol/test_protocol.cpp`

**Interfaces:**
- Consumes: ArduinoJson v7.
- Produces:
  - `enum class MsgKind { Ignore, Light, Sound };`
  - `enum class Color { Red, Green, Yellow, Blue };`
  - `enum class Pattern { Solid, Flash, Pulse };`
  - `struct LightCommand { Color color; Pattern pattern; uint8_t brightness; uint32_t duration_ms; uint8_t repeat_count; };`
  - `struct SoundCommand { char sound[41]; uint8_t volume; uint32_t duration_ms; uint8_t repeat_count; };`
  - `struct ParsedMessage { MsgKind kind; LightCommand light; SoundCommand sound; };`
  - `ParsedMessage parse_message(const char* json, size_t len);`

- [ ] **Step 1: Write `src/protocol.h`**

```cpp
#pragma once
#include <stdint.h>
#include <stddef.h>

enum class MsgKind : uint8_t { Ignore, Light, Sound };
enum class Color   : uint8_t { Red, Green, Yellow, Blue };
enum class Pattern : uint8_t { Solid, Flash, Pulse };

struct LightCommand {
  Color    color;
  Pattern  pattern;
  uint8_t  brightness;   // 0..100
  uint32_t duration_ms;  // >=1
  uint8_t  repeat_count; // 1..5
};

struct SoundCommand {
  char     sound[41];    // up to 40 chars + NUL
  uint8_t  volume;       // 0..100
  uint32_t duration_ms;  // >=1
  uint8_t  repeat_count; // 1..5
};

struct ParsedMessage {
  MsgKind      kind;
  LightCommand light;
  SoundCommand sound;
};

// Parse one UDP datagram. Returns kind==Ignore for anything not understood
// (bad JSON, v!=1, unknown type, unknown color/pattern, empty sound id).
ParsedMessage parse_message(const char* json, size_t len);
```

- [ ] **Step 2: Write the failing test `test/test_protocol/test_protocol.cpp`**

```cpp
#include <unity.h>
#include <string.h>
#include "protocol.h"

void setUp(void) {}
void tearDown(void) {}

void test_light_full(void) {
  const char* j = "{\"v\":1,\"type\":\"light\",\"pattern\":\"flash\",\"color\":\"red\","
                  "\"brightness\":80,\"duration\":500,\"repeat_count\":3}";
  ParsedMessage m = parse_message(j, strlen(j));
  TEST_ASSERT_EQUAL_INT((int)MsgKind::Light, (int)m.kind);
  TEST_ASSERT_EQUAL_INT((int)Color::Red, (int)m.light.color);
  TEST_ASSERT_EQUAL_INT((int)Pattern::Flash, (int)m.light.pattern);
  TEST_ASSERT_EQUAL_UINT8(80, m.light.brightness);
  TEST_ASSERT_EQUAL_UINT32(500, m.light.duration_ms);
  TEST_ASSERT_EQUAL_UINT8(3, m.light.repeat_count);
}

void test_sound_full(void) {
  const char* j = "{\"v\":1,\"type\":\"sound\",\"sound\":\"alert\","
                  "\"volume\":70,\"duration\":400,\"repeat_count\":2}";
  ParsedMessage m = parse_message(j, strlen(j));
  TEST_ASSERT_EQUAL_INT((int)MsgKind::Sound, (int)m.kind);
  TEST_ASSERT_EQUAL_STRING("alert", m.sound.sound);
  TEST_ASSERT_EQUAL_UINT8(70, m.sound.volume);
  TEST_ASSERT_EQUAL_UINT8(2, m.sound.repeat_count);
}

void test_wrong_version_ignored(void) {
  const char* j = "{\"v\":2,\"type\":\"light\",\"pattern\":\"solid\",\"color\":\"red\"}";
  ParsedMessage m = parse_message(j, strlen(j));
  TEST_ASSERT_EQUAL_INT((int)MsgKind::Ignore, (int)m.kind);
}

void test_unknown_type_ignored(void) {
  const char* j = "{\"v\":1,\"type\":\"buzz\"}";
  ParsedMessage m = parse_message(j, strlen(j));
  TEST_ASSERT_EQUAL_INT((int)MsgKind::Ignore, (int)m.kind);
}

void test_unknown_color_ignored(void) {
  const char* j = "{\"v\":1,\"type\":\"light\",\"pattern\":\"solid\",\"color\":\"purple\"}";
  ParsedMessage m = parse_message(j, strlen(j));
  TEST_ASSERT_EQUAL_INT((int)MsgKind::Ignore, (int)m.kind);
}

void test_bad_json_ignored(void) {
  const char* j = "not json at all";
  ParsedMessage m = parse_message(j, strlen(j));
  TEST_ASSERT_EQUAL_INT((int)MsgKind::Ignore, (int)m.kind);
}

void test_clamping(void) {
  const char* j = "{\"v\":1,\"type\":\"light\",\"pattern\":\"solid\",\"color\":\"green\","
                  "\"brightness\":250,\"duration\":0,\"repeat_count\":99}";
  ParsedMessage m = parse_message(j, strlen(j));
  TEST_ASSERT_EQUAL_INT((int)MsgKind::Light, (int)m.kind);
  TEST_ASSERT_EQUAL_UINT8(100, m.light.brightness);     // clamped 0..100
  TEST_ASSERT_EQUAL_UINT32(1, m.light.duration_ms);     // clamped >=1
  TEST_ASSERT_EQUAL_UINT8(5, m.light.repeat_count);     // clamped 1..5
}

void test_defaults_applied(void) {
  // Missing optional fields fall back to documented defaults.
  const char* j = "{\"v\":1,\"type\":\"light\",\"pattern\":\"solid\",\"color\":\"blue\"}";
  ParsedMessage m = parse_message(j, strlen(j));
  TEST_ASSERT_EQUAL_INT((int)MsgKind::Light, (int)m.kind);
  TEST_ASSERT_EQUAL_UINT8(100, m.light.brightness);
  TEST_ASSERT_EQUAL_UINT8(1, m.light.repeat_count);
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_light_full);
  RUN_TEST(test_sound_full);
  RUN_TEST(test_wrong_version_ignored);
  RUN_TEST(test_unknown_type_ignored);
  RUN_TEST(test_unknown_color_ignored);
  RUN_TEST(test_bad_json_ignored);
  RUN_TEST(test_clamping);
  RUN_TEST(test_defaults_applied);
  return UNITY_END();
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `pio test -e native -f test_protocol`
Expected: FAIL — link error / undefined reference to `parse_message` (not implemented yet).

- [ ] **Step 4: Implement `src/protocol.cpp`**

```cpp
#include "protocol.h"
#include <ArduinoJson.h>
#include <string.h>

static uint8_t clamp_u8(long v, long lo, long hi) {
  if (v < lo) return (uint8_t)lo;
  if (v > hi) return (uint8_t)hi;
  return (uint8_t)v;
}

static bool parse_color(const char* s, Color& out) {
  if (!strcmp(s, "red"))    { out = Color::Red;    return true; }
  if (!strcmp(s, "green"))  { out = Color::Green;  return true; }
  if (!strcmp(s, "yellow")) { out = Color::Yellow; return true; }
  if (!strcmp(s, "blue"))   { out = Color::Blue;   return true; }
  return false;
}

static bool parse_pattern(const char* s, Pattern& out) {
  if (!strcmp(s, "solid")) { out = Pattern::Solid; return true; }
  if (!strcmp(s, "flash")) { out = Pattern::Flash; return true; }
  if (!strcmp(s, "pulse")) { out = Pattern::Pulse; return true; }
  return false;
}

static uint32_t clamp_duration(long d) {
  if (d < 1)     return 1;
  if (d > 60000) return 60000;
  return (uint32_t)d;
}

ParsedMessage parse_message(const char* json, size_t len) {
  ParsedMessage m;
  m.kind = MsgKind::Ignore;

  JsonDocument doc;
  if (deserializeJson(doc, json, len)) return m;   // bad JSON

  int v = doc["v"] | 0;
  if (v != 1) return m;                            // unknown schema version

  const char* type = doc["type"] | "";

  if (!strcmp(type, "light")) {
    Color color; Pattern pattern;
    if (!parse_color(doc["color"] | "", color))     return m;  // unknown color -> ignore
    if (!parse_pattern(doc["pattern"] | "", pattern)) return m;
    m.light.color        = color;
    m.light.pattern      = pattern;
    m.light.brightness   = clamp_u8(doc["brightness"] | 100, 0, 100);
    m.light.duration_ms  = clamp_duration(doc["duration"] | 500);
    m.light.repeat_count = clamp_u8(doc["repeat_count"] | 1, 1, 5);
    m.kind = MsgKind::Light;
    return m;
  }

  if (!strcmp(type, "sound")) {
    const char* snd = doc["sound"] | "";
    if (snd[0] == '\0') return m;                   // empty id -> ignore
    strncpy(m.sound.sound, snd, 40);
    m.sound.sound[40]    = '\0';
    m.sound.volume       = clamp_u8(doc["volume"] | 100, 0, 100);
    m.sound.duration_ms  = clamp_duration(doc["duration"] | 400);
    m.sound.repeat_count = clamp_u8(doc["repeat_count"] | 1, 1, 5);
    m.kind = MsgKind::Sound;
    return m;
  }

  return m;  // unknown type -> Ignore
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pio test -e native -f test_protocol`
Expected: PASS — `8 Tests 0 Failures`.

- [ ] **Step 6: Commit**

```bash
git add esp_stacklight/src/protocol.h esp_stacklight/src/protocol.cpp esp_stacklight/test/test_protocol
git commit -m "feat(esp_stacklight): protocol JSON parse with version gate and clamping"
```

---

### Task 3: Lamp state machine (native TDD)

**Files:**
- Create: `src/lamp_state.h`
- Create: `src/lamp_state.cpp`
- Test: `test/test_lamp_state/test_lamp_state.cpp`

**Interfaces:**
- Consumes: `LightCommand`, `Pattern` from `protocol.h`.
- Produces:
  - `class LampState { public: LampState(); void apply(const LightCommand& c, uint32_t now_ms); uint8_t duty(uint32_t now_ms) const; };`
  - `duty()` returns 0..255 PWM duty. Pure, no hardware.

- [ ] **Step 1: Write `src/lamp_state.h`**

```cpp
#pragma once
#include <stdint.h>
#include "protocol.h"

// Pure per-color animation state. duty() maps elapsed time to an 8-bit PWM duty.
class LampState {
public:
  LampState();
  void    apply(const LightCommand& c, uint32_t now_ms);
  uint8_t duty(uint32_t now_ms) const;   // 0..255
private:
  Pattern  pattern_;
  uint8_t  base_duty_;     // brightness mapped to 0..255
  uint32_t period_ms_;     // one cycle (>=1)
  uint8_t  repeat_count_;  // 1..5
  uint32_t start_ms_;
};
```

- [ ] **Step 2: Write the failing test `test/test_lamp_state/test_lamp_state.cpp`**

```cpp
#include <unity.h>
#include "lamp_state.h"

void setUp(void) {}
void tearDown(void) {}

static LightCommand cmd(Pattern p, uint8_t bright, uint32_t dur, uint8_t rep) {
  LightCommand c;
  c.color = Color::Red;
  c.pattern = p;
  c.brightness = bright;
  c.duration_ms = dur;
  c.repeat_count = rep;
  return c;
}

void test_initial_off(void) {
  LampState s;
  TEST_ASSERT_EQUAL_UINT8(0, s.duty(0));
  TEST_ASSERT_EQUAL_UINT8(0, s.duty(10000));
}

void test_solid_full_holds(void) {
  LampState s;
  s.apply(cmd(Pattern::Solid, 100, 500, 1), 1000);
  TEST_ASSERT_EQUAL_UINT8(255, s.duty(1000));
  TEST_ASSERT_EQUAL_UINT8(255, s.duty(99999));   // holds forever
}

void test_solid_brightness_zero_off(void) {
  LampState s;
  s.apply(cmd(Pattern::Solid, 0, 500, 1), 0);
  TEST_ASSERT_EQUAL_UINT8(0, s.duty(0));
  TEST_ASSERT_EQUAL_UINT8(0, s.duty(5000));
}

void test_solid_brightness_scaled(void) {
  LampState s;
  s.apply(cmd(Pattern::Solid, 80, 500, 1), 0);
  TEST_ASSERT_EQUAL_UINT8(204, s.duty(0));       // round(80*255/100)
}

void test_flash_square_then_off(void) {
  LampState s;
  s.apply(cmd(Pattern::Flash, 100, 500, 3), 0);  // period 500, 3 cycles -> off at 1500
  TEST_ASSERT_EQUAL_UINT8(255, s.duty(0));       // first half on
  TEST_ASSERT_EQUAL_UINT8(0,   s.duty(300));     // second half off
  TEST_ASSERT_EQUAL_UINT8(255, s.duty(500));     // next cycle on
  TEST_ASSERT_EQUAL_UINT8(0,   s.duty(1500));    // all cycles done -> off
  TEST_ASSERT_EQUAL_UINT8(0,   s.duty(9000));    // stays off
}

void test_pulse_peaks_midcycle_then_off(void) {
  LampState s;
  s.apply(cmd(Pattern::Pulse, 100, 400, 1), 0);  // period 400, 1 cycle -> off at 400
  TEST_ASSERT_EQUAL_UINT8(0,   s.duty(0));        // starts dark
  TEST_ASSERT_EQUAL_UINT8(255, s.duty(200));      // peak at half period
  TEST_ASSERT_EQUAL_UINT8(0,   s.duty(400));      // cycle done -> off
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_initial_off);
  RUN_TEST(test_solid_full_holds);
  RUN_TEST(test_solid_brightness_zero_off);
  RUN_TEST(test_solid_brightness_scaled);
  RUN_TEST(test_flash_square_then_off);
  RUN_TEST(test_pulse_peaks_midcycle_then_off);
  return UNITY_END();
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `pio test -e native -f test_lamp_state`
Expected: FAIL — undefined reference to `LampState` methods.

- [ ] **Step 4: Implement `src/lamp_state.cpp`**

```cpp
#include "lamp_state.h"

static uint8_t bright_to_duty(uint8_t b) {        // 0..100 -> 0..255 (rounded)
  return (uint8_t)((b * 255 + 50) / 100);
}

LampState::LampState()
  : pattern_(Pattern::Solid), base_duty_(0),
    period_ms_(1), repeat_count_(1), start_ms_(0) {}

void LampState::apply(const LightCommand& c, uint32_t now_ms) {
  base_duty_    = bright_to_duty(c.brightness);
  pattern_      = c.pattern;
  period_ms_    = c.duration_ms < 1 ? 1 : c.duration_ms;
  repeat_count_ = c.repeat_count < 1 ? 1 : c.repeat_count;
  start_ms_     = now_ms;
}

uint8_t LampState::duty(uint32_t now_ms) const {
  uint32_t elapsed = now_ms - start_ms_;          // unsigned wrap is fine for our horizon

  switch (pattern_) {
    case Pattern::Solid:
      return base_duty_;                            // holds until next apply()

    case Pattern::Flash: {
      if (elapsed >= period_ms_ * repeat_count_) return 0;
      uint32_t phase = elapsed % period_ms_;
      return (phase < period_ms_ / 2) ? base_duty_ : 0;
    }

    case Pattern::Pulse: {
      if (elapsed >= period_ms_ * repeat_count_) return 0;
      uint32_t phase = elapsed % period_ms_;
      uint32_t half  = period_ms_ / 2;
      if (half == 0) return base_duty_;
      uint32_t level;
      if (phase < half)
        level = (uint32_t)base_duty_ * phase / half;                    // ramp up
      else
        level = (uint32_t)base_duty_ * (period_ms_ - phase) / (period_ms_ - half); // ramp down
      return (uint8_t)level;
    }
  }
  return 0;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pio test -e native -f test_lamp_state`
Expected: PASS — `6 Tests 0 Failures`.

- [ ] **Step 6: Commit**

```bash
git add esp_stacklight/src/lamp_state.h esp_stacklight/src/lamp_state.cpp esp_stacklight/test/test_lamp_state
git commit -m "feat(esp_stacklight): lamp state machine (solid/flash/pulse, end-off)"
```

---

### Task 4: Lamps hardware wrapper (LEDC, on-device)

**Files:**
- Create: `src/lamps.h`
- Create: `src/lamps.cpp`

**Interfaces:**
- Consumes: `LightCommand`, `Color` (protocol.h); `LampState` (lamp_state.h); pin/LEDC macros (config.h).
- Produces:
  - `class Lamps { public: void begin(); void apply(const LightCommand& c, uint32_t now_ms); void update(uint32_t now_ms); };`
  - Holds 4 `LampState` indexed by `Color`; `update()` writes each duty to its LEDC pin.

- [ ] **Step 1: Write `src/lamps.h`**

```cpp
#pragma once
#include "protocol.h"
#include "lamp_state.h"

class Lamps {
public:
  void begin();                                      // configure LEDC on the 4 pins
  void apply(const LightCommand& c, uint32_t now_ms);// route to the color's state machine
  void update(uint32_t now_ms);                      // write all 4 duties to PWM
private:
  LampState state_[4];                               // indexed by (int)Color
};
```

- [ ] **Step 2: Implement `src/lamps.cpp`** (Arduino-ESP32 core 3.x LEDC API: `ledcAttach(pin, freq, res)`, `ledcWrite(pin, duty)`)

```cpp
#include "lamps.h"
#include "config.h"
#include <Arduino.h>

static const int LAMP_PINS[4] = {
  PIN_LAMP_RED, PIN_LAMP_GREEN, PIN_LAMP_YELLOW, PIN_LAMP_BLUE
};

void Lamps::begin() {
  for (int i = 0; i < 4; i++) {
    ledcAttach(LAMP_PINS[i], LEDC_FREQ_HZ, LEDC_RES_BITS);
    ledcWrite(LAMP_PINS[i], 0);
  }
}

void Lamps::apply(const LightCommand& c, uint32_t now_ms) {
  state_[(int)c.color].apply(c, now_ms);
}

void Lamps::update(uint32_t now_ms) {
  for (int i = 0; i < 4; i++) {
    ledcWrite(LAMP_PINS[i], state_[i].duty(now_ms));
  }
}
```

- [ ] **Step 3: Verify it compiles for the device**

Run: `pio run -e esp32dev`
Expected: build succeeds (this also links nothing that calls Lamps yet — that's fine; the file compiles as part of the env).

> Note: there is no `main` wiring until Task 9. If the env requires a `main`/`setup`/`loop` to link, this compile-check is satisfied by Task 9's build; here just confirm `lamps.cpp` has no compile errors via `pio run -e esp32dev 2>&1 | grep -i lamps` showing no errors. If the link stage fails only for a missing `setup/loop`, that is expected at this task.

- [ ] **Step 4: On-device smoke (deferred to Task 9 end-to-end)**

Bench check happens in Task 9 once `main` drives `Lamps`. No standalone hardware test here.

- [ ] **Step 5: Commit**

```bash
git add esp_stacklight/src/lamps.h esp_stacklight/src/lamps.cpp
git commit -m "feat(esp_stacklight): LEDC PWM lamp driver wrapping the state machine"
```

---

### Task 5: WAV header + volume + sound map (native TDD)

**Files:**
- Create: `src/wav.h`
- Create: `src/wav.cpp`
- Create: `src/sound_map.h`
- Create: `src/sound_map.cpp`
- Test: `test/test_wav/test_wav.cpp`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `struct WavInfo { bool valid; uint16_t channels; uint32_t sample_rate; uint16_t bits_per_sample; uint32_t data_offset; uint32_t data_size; };`
  - `WavInfo wav_parse_header(const uint8_t* buf, size_t len);`
  - `int16_t wav_scale_sample(int16_t sample, uint8_t volume);`
  - `const char* sound_file_for(const char* id);` (returns LittleFS path or `nullptr`)

- [ ] **Step 1: Write `src/wav.h`**

```cpp
#pragma once
#include <stdint.h>
#include <stddef.h>

struct WavInfo {
  bool     valid;
  uint16_t channels;
  uint32_t sample_rate;
  uint16_t bits_per_sample;
  uint32_t data_offset;   // byte offset of PCM data
  uint32_t data_size;     // bytes of PCM data
};

WavInfo wav_parse_header(const uint8_t* buf, size_t len);
int16_t wav_scale_sample(int16_t sample, uint8_t volume);  // volume 0..100
```

- [ ] **Step 2: Write `src/sound_map.h`**

```cpp
#pragma once
// Map a protocol sound identifier to a LittleFS path. nullptr if unknown.
const char* sound_file_for(const char* id);
```

- [ ] **Step 3: Write the failing test `test/test_wav/test_wav.cpp`**

```cpp
#include <unity.h>
#include <string.h>
#include "wav.h"
#include "sound_map.h"

void setUp(void) {}
void tearDown(void) {}

static void put_u32(uint8_t* p, uint32_t v){ p[0]=v; p[1]=v>>8; p[2]=v>>16; p[3]=v>>24; }
static void put_u16(uint8_t* p, uint16_t v){ p[0]=v; p[1]=v>>8; }

static size_t build_wav(uint8_t* b) {
  memcpy(b, "RIFF", 4);     put_u32(b+4, 44 - 8 + 8);
  memcpy(b+8, "WAVE", 4);
  memcpy(b+12, "fmt ", 4);  put_u32(b+16, 16);
  put_u16(b+20, 1);         // PCM
  put_u16(b+22, 1);         // mono
  put_u32(b+24, 16000);     // sample rate
  put_u32(b+28, 32000);     // byte rate
  put_u16(b+32, 2);         // block align
  put_u16(b+34, 16);        // bits per sample
  memcpy(b+36, "data", 4);  put_u32(b+40, 8);
  return 44 + 8;            // header + 8 bytes data
}

void test_wav_header_parse(void) {
  uint8_t b[64]; memset(b, 0, sizeof(b));
  size_t n = build_wav(b);
  WavInfo w = wav_parse_header(b, n);
  TEST_ASSERT_TRUE(w.valid);
  TEST_ASSERT_EQUAL_UINT16(1, w.channels);
  TEST_ASSERT_EQUAL_UINT32(16000, w.sample_rate);
  TEST_ASSERT_EQUAL_UINT16(16, w.bits_per_sample);
  TEST_ASSERT_EQUAL_UINT32(44, w.data_offset);
  TEST_ASSERT_EQUAL_UINT32(8, w.data_size);
}

void test_wav_rejects_non_riff(void) {
  uint8_t b[16]; memset(b, 0, sizeof(b));
  memcpy(b, "XXXX", 4);
  WavInfo w = wav_parse_header(b, sizeof(b));
  TEST_ASSERT_FALSE(w.valid);
}

void test_volume_scaling(void) {
  TEST_ASSERT_EQUAL_INT16(1000, wav_scale_sample(1000, 100));  // full
  TEST_ASSERT_EQUAL_INT16(500,  wav_scale_sample(1000, 50));   // half
  TEST_ASSERT_EQUAL_INT16(0,    wav_scale_sample(1000, 0));    // mute
  TEST_ASSERT_EQUAL_INT16(-250, wav_scale_sample(-1000, 25));  // negative preserved
}

void test_sound_map(void) {
  TEST_ASSERT_EQUAL_STRING("/alert.wav", sound_file_for("alert"));
  TEST_ASSERT_EQUAL_STRING("/error.wav", sound_file_for("error"));
  TEST_ASSERT_EQUAL_STRING("/info.wav",  sound_file_for("info"));
  TEST_ASSERT_NULL(sound_file_for("nope"));
  TEST_ASSERT_NULL(sound_file_for(""));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_wav_header_parse);
  RUN_TEST(test_wav_rejects_non_riff);
  RUN_TEST(test_volume_scaling);
  RUN_TEST(test_sound_map);
  return UNITY_END();
}
```

- [ ] **Step 4: Run to verify it fails**

Run: `pio test -e native -f test_wav`
Expected: FAIL — undefined references to `wav_parse_header`, `wav_scale_sample`, `sound_file_for`.

- [ ] **Step 5: Implement `src/wav.cpp`**

```cpp
#include "wav.h"
#include <string.h>

static uint32_t rd_u32(const uint8_t* p){ return p[0] | (p[1]<<8) | (p[2]<<16) | ((uint32_t)p[3]<<24); }
static uint16_t rd_u16(const uint8_t* p){ return (uint16_t)(p[0] | (p[1]<<8)); }

WavInfo wav_parse_header(const uint8_t* buf, size_t len) {
  WavInfo w; memset(&w, 0, sizeof(w)); w.valid = false;
  if (len < 12) return w;
  if (memcmp(buf, "RIFF", 4) != 0)     return w;
  if (memcmp(buf + 8, "WAVE", 4) != 0) return w;

  size_t pos = 12;
  bool haveFmt = false, haveData = false;
  while (pos + 8 <= len) {
    const uint8_t* ck = buf + pos;
    uint32_t cksize = rd_u32(ck + 4);
    const uint8_t* body = ck + 8;
    if (memcmp(ck, "fmt ", 4) == 0 && pos + 8 + 16 <= len) {
      w.channels        = rd_u16(body + 2);
      w.sample_rate     = rd_u32(body + 4);
      w.bits_per_sample = rd_u16(body + 14);
      haveFmt = true;
    } else if (memcmp(ck, "data", 4) == 0) {
      w.data_offset = (uint32_t)(pos + 8);
      w.data_size   = cksize;
      haveData = true;
      break;
    }
    pos += 8 + cksize + (cksize & 1);   // chunks are word-aligned
  }
  w.valid = haveFmt && haveData;
  return w;
}

int16_t wav_scale_sample(int16_t s, uint8_t volume) {
  if (volume >= 100) return s;
  return (int16_t)((int32_t)s * (int32_t)volume / 100);
}
```

- [ ] **Step 6: Implement `src/sound_map.cpp`**

```cpp
#include "sound_map.h"
#include <string.h>

struct Entry { const char* id; const char* path; };

// Extend this table as StackPI introduces new sound identifiers.
static const Entry kMap[] = {
  { "alert", "/alert.wav" },
  { "error", "/error.wav" },
  { "info",  "/info.wav"  },
};

const char* sound_file_for(const char* id) {
  if (!id || id[0] == '\0') return nullptr;
  for (const auto& e : kMap)
    if (strcmp(e.id, id) == 0) return e.path;
  return nullptr;
}
```

- [ ] **Step 7: Run to verify it passes**

Run: `pio test -e native -f test_wav`
Expected: PASS — `4 Tests 0 Failures`.

- [ ] **Step 8: Commit**

```bash
git add esp_stacklight/src/wav.h esp_stacklight/src/wav.cpp esp_stacklight/src/sound_map.h esp_stacklight/src/sound_map.cpp esp_stacklight/test/test_wav
git commit -m "feat(esp_stacklight): WAV header parse, volume scaling, sound-id map"
```

---

### Task 6: Audio playback (I2S + LittleFS + FreeRTOS task, on-device)

**Files:**
- Create: `src/audio.h`
- Create: `src/audio.cpp`
- Create: `data/README.md` (LittleFS asset instructions)

**Interfaces:**
- Consumes: `SoundCommand` (protocol.h); `wav_parse_header`/`wav_scale_sample` (wav.h); `sound_file_for` (sound_map.h); I2S pin macros (config.h).
- Produces:
  - `void audio_begin();` — mounts LittleFS, sets up I2S, starts the playback task on core 0.
  - `void audio_play(const SoundCommand& c);` — resolves the file and enqueues it; preempts any current playback (latest wins).

- [ ] **Step 1: Write `src/audio.h`**

```cpp
#pragma once
#include "protocol.h"

void audio_begin();                       // LittleFS + I2S + playback task (core 0)
void audio_play(const SoundCommand& c);   // enqueue (preempts current playback)
```

- [ ] **Step 2: Implement `src/audio.cpp`** (Arduino-ESP32 core 3.x `ESP_I2S` + LittleFS; playback task pinned to core 0; preemption via single-slot queue overwrite)

```cpp
#include "audio.h"
#include "config.h"
#include "wav.h"
#include "sound_map.h"
#include <Arduino.h>
#include <LittleFS.h>
#include <ESP_I2S.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>

namespace {

struct PlayReq {
  char    path[48];
  uint8_t volume;
  uint8_t repeat;
};

I2SClass    i2s;
QueueHandle_t g_queue = nullptr;   // length 1; newest request preempts

void play_file(const PlayReq& req) {
  File f = LittleFS.open(req.path, "r");
  if (!f) { log_e("audio: missing %s", req.path); return; }

  uint8_t hdr[64];
  size_t n = f.read(hdr, sizeof(hdr));
  WavInfo w = wav_parse_header(hdr, n);
  if (!w.valid || w.bits_per_sample != 16) {
    log_e("audio: bad/unsupported WAV %s", req.path);
    f.close();
    return;
  }

  i2s.end();
  i2s.setPins(PIN_I2S_BCLK, PIN_I2S_LRC, PIN_I2S_DIN);
  i2s.begin(I2S_MODE_STD, w.sample_rate, I2S_DATA_BIT_WIDTH_16BIT,
            I2S_SLOT_MODE_MONO);

  for (uint8_t rep = 0; rep < req.repeat; rep++) {
    f.seek(w.data_offset);
    uint32_t remaining = w.data_size;
    int16_t buf[256];
    while (remaining > 0) {
      if (uxQueueMessagesWaiting(g_queue) > 0) { f.close(); return; } // preempt
      size_t want = remaining < sizeof(buf) ? remaining : sizeof(buf);
      size_t got  = f.read((uint8_t*)buf, want);
      if (got == 0) break;
      size_t samples = got / 2;
      for (size_t i = 0; i < samples; i++) buf[i] = wav_scale_sample(buf[i], req.volume);
      i2s.write((uint8_t*)buf, samples * 2);
      remaining -= got;
    }
  }
  f.close();
}

void audio_task(void*) {
  PlayReq req;
  for (;;) {
    if (xQueueReceive(g_queue, &req, portMAX_DELAY) == pdTRUE) {
      play_file(req);
    }
  }
}

} // namespace

void audio_begin() {
  if (!LittleFS.begin(true)) {
    log_e("audio: LittleFS mount failed");
  }
  g_queue = xQueueCreate(1, sizeof(PlayReq));
  xTaskCreatePinnedToCore(audio_task, "audio", 4096, nullptr, 1, nullptr, 0);
}

void audio_play(const SoundCommand& c) {
  const char* path = sound_file_for(c.sound);
  if (!path) { log_w("audio: unknown sound '%s'", c.sound); return; }

  PlayReq req;
  strncpy(req.path, path, sizeof(req.path) - 1);
  req.path[sizeof(req.path) - 1] = '\0';
  req.volume = c.volume;
  req.repeat = c.repeat_count;

  xQueueOverwrite(g_queue, &req);   // newest wins; playing task preempts itself
}
```

- [ ] **Step 3: Write `data/README.md`**

```markdown
# LittleFS audio assets

Place 16-bit PCM **mono** WAV files here. Filenames must match `src/sound_map.cpp`:

- `alert.wav`
- `error.wav`
- `info.wav`

Convert with, e.g.:

    ffmpeg -i input.mp3 -ac 1 -ar 22050 -sample_fmt s16 alert.wav

Upload to the device with:

    pio run -e esp32dev -t uploadfs
```

- [ ] **Step 4: Verify it compiles for the device**

Run: `pio run -e esp32dev`
Expected: compiles `audio.cpp` with no errors (link may still need `main` until Task 9).

- [ ] **Step 5: On-device verification (deferred to Task 9)**

Real audio playback is verified end-to-end in Task 9 with WAV files uploaded and a `sound` message sent.

- [ ] **Step 6: Commit**

```bash
git add esp_stacklight/src/audio.h esp_stacklight/src/audio.cpp esp_stacklight/data/README.md
git commit -m "feat(esp_stacklight): I2S WAV playback task with preemption"
```

---

### Task 7: Address/port validation (native TDD) + NVS config (on-device)

**Files:**
- Create: `src/net_validate.h`
- Create: `src/net_validate.cpp`
- Create: `src/settings.h`
- Create: `src/settings.cpp`
- Test: `test/test_net_validate/test_net_validate.cpp`

**Interfaces:**
- Consumes: defaults (config.h); Preferences (Arduino, for settings.cpp).
- Produces:
  - `bool valid_multicast_group(const char* ip);` (224.0.0.0–239.255.255.255)
  - `bool valid_port(long port);` (1–65535)
  - `struct Settings { char group[16]; uint16_t port; };`
  - `Settings settings_load();` / `void settings_save(const Settings& s);` (NVS via Preferences)

- [ ] **Step 1: Write `src/net_validate.h`**

```cpp
#pragma once
// Pure validators for the operator-supplied multicast group/port.
bool valid_multicast_group(const char* ip);  // 224.0.0.0 .. 239.255.255.255
bool valid_port(long port);                   // 1 .. 65535
```

- [ ] **Step 2: Write the failing test `test/test_net_validate/test_net_validate.cpp`**

```cpp
#include <unity.h>
#include "net_validate.h"

void setUp(void) {}
void tearDown(void) {}

void test_valid_groups(void) {
  TEST_ASSERT_TRUE(valid_multicast_group("239.10.10.10"));
  TEST_ASSERT_TRUE(valid_multicast_group("224.0.0.1"));
  TEST_ASSERT_TRUE(valid_multicast_group("239.255.255.255"));
}

void test_invalid_groups(void) {
  TEST_ASSERT_FALSE(valid_multicast_group("192.168.1.1")); // not multicast
  TEST_ASSERT_FALSE(valid_multicast_group("240.0.0.1"));   // above range
  TEST_ASSERT_FALSE(valid_multicast_group("223.0.0.1"));   // below range
  TEST_ASSERT_FALSE(valid_multicast_group("239.10.10"));   // too few octets
  TEST_ASSERT_FALSE(valid_multicast_group("239.10.10.256"));// octet > 255
  TEST_ASSERT_FALSE(valid_multicast_group("hello"));        // garbage
}

void test_ports(void) {
  TEST_ASSERT_TRUE(valid_port(5005));
  TEST_ASSERT_TRUE(valid_port(1));
  TEST_ASSERT_TRUE(valid_port(65535));
  TEST_ASSERT_FALSE(valid_port(0));
  TEST_ASSERT_FALSE(valid_port(65536));
  TEST_ASSERT_FALSE(valid_port(-1));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_valid_groups);
  RUN_TEST(test_invalid_groups);
  RUN_TEST(test_ports);
  return UNITY_END();
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `pio test -e native -f test_net_validate`
Expected: FAIL — undefined references.

- [ ] **Step 4: Implement `src/net_validate.cpp`**

```cpp
#include "net_validate.h"
#include <stdlib.h>
#include <ctype.h>

bool valid_port(long port) { return port >= 1 && port <= 65535; }

bool valid_multicast_group(const char* ip) {
  if (!ip) return false;
  int octets[4];
  int idx = 0;
  const char* p = ip;
  while (idx < 4) {
    if (!isdigit((unsigned char)*p)) return false;
    long v = 0;
    int digits = 0;
    while (isdigit((unsigned char)*p)) { v = v * 10 + (*p - '0'); p++; digits++; if (v > 255) return false; }
    if (digits == 0) return false;
    octets[idx++] = (int)v;
    if (idx < 4) { if (*p != '.') return false; p++; }
  }
  if (*p != '\0') return false;                 // trailing junk / extra octets
  return octets[0] >= 224 && octets[0] <= 239;  // IPv4 multicast range
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pio test -e native -f test_net_validate`
Expected: PASS — `3 Tests 0 Failures`.

- [ ] **Step 6: Write `src/settings.h`**

```cpp
#pragma once
#include <stdint.h>

struct Settings {
  char     group[16];   // multicast group, e.g. "239.10.10.10"
  uint16_t port;        // multicast port
};

Settings settings_load();              // from NVS, falling back to config.h defaults
void     settings_save(const Settings& s);
```

- [ ] **Step 7: Implement `src/settings.cpp`** (NVS via Preferences; on-device)

```cpp
#include "settings.h"
#include "config.h"
#include "net_validate.h"
#include <Arduino.h>
#include <Preferences.h>
#include <string.h>

static const char* NS = "stacklight";

Settings settings_load() {
  Settings s;
  Preferences p;
  p.begin(NS, true);                       // read-only
  String g = p.getString("group", DEFAULT_MCAST_GROUP);
  uint32_t port = p.getUInt("port", DEFAULT_MCAST_PORT);
  p.end();

  if (!valid_multicast_group(g.c_str())) g = DEFAULT_MCAST_GROUP;
  if (!valid_port((long)port))           port = DEFAULT_MCAST_PORT;

  strncpy(s.group, g.c_str(), sizeof(s.group) - 1);
  s.group[sizeof(s.group) - 1] = '\0';
  s.port = (uint16_t)port;
  return s;
}

void settings_save(const Settings& s) {
  Preferences p;
  p.begin(NS, false);                      // read-write
  p.putString("group", s.group);
  p.putUInt("port", s.port);
  p.end();
}
```

- [ ] **Step 8: Verify device compile**

Run: `pio run -e esp32dev`
Expected: `settings.cpp` compiles with no errors.

- [ ] **Step 9: Commit**

```bash
git add esp_stacklight/src/net_validate.h esp_stacklight/src/net_validate.cpp esp_stacklight/src/settings.h esp_stacklight/src/settings.cpp esp_stacklight/test/test_net_validate
git commit -m "feat(esp_stacklight): multicast group/port validation + NVS settings"
```

---

### Task 8: Network — WiFiManager captive portal + multicast receive (on-device)

**Files:**
- Create: `src/net.h`
- Create: `src/net.cpp`

**Interfaces:**
- Consumes: `Settings`, `settings_load`/`settings_save` (settings.h); `valid_*` (net_validate.h); `AP_NAME` (config.h).
- Produces:
  - `enum class NetState { Portal, Connecting, Connected, Disconnected };`
  - `void net_begin();` — load settings, run WiFiManager (portal on first boot / failure) with custom group+port fields, persist to NVS on save, join multicast.
  - `int net_poll(char* buf, size_t maxlen);` — returns datagram length (0 if none).
  - `NetState net_state();` — current link state for status indication.

- [ ] **Step 1: Write `src/net.h`**

```cpp
#pragma once
#include <stddef.h>

enum class NetState : uint8_t { Portal, Connecting, Connected, Disconnected };

void     net_begin();                          // WiFiManager + multicast join
int      net_poll(char* buf, size_t maxlen);   // 0 if no datagram
NetState net_state();
```

- [ ] **Step 2: Implement `src/net.cpp`** (WiFiManager custom params for group/port; `WiFiUDP::beginMulticast`)

```cpp
#include "net.h"
#include "config.h"
#include "settings.h"
#include "net_validate.h"
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <WiFiManager.h>

namespace {
WiFiUDP   udp;
Settings  g_settings;
NetState  g_state = NetState::Connecting;
bool      g_portal = false;

void on_portal(WiFiManager*) { g_portal = true; }
}

void net_begin() {
  g_settings = settings_load();

  char portStr[8];
  snprintf(portStr, sizeof(portStr), "%u", g_settings.port);

  WiFiManager wm;
  WiFiManagerParameter pGroup("group", "Multicast group", g_settings.group, 16);
  WiFiManagerParameter pPort ("port",  "Multicast port",  portStr, 8);
  wm.addParameter(&pGroup);
  wm.addParameter(&pPort);
  wm.setAPCallback(on_portal);

  g_state = NetState::Connecting;
  bool ok = wm.autoConnect(AP_NAME);   // blocks: portal if no saved creds / fail

  // Persist any operator edits to group/port.
  Settings edited = g_settings;
  if (valid_multicast_group(pGroup.getValue())) {
    strncpy(edited.group, pGroup.getValue(), sizeof(edited.group) - 1);
    edited.group[sizeof(edited.group) - 1] = '\0';
  }
  long port = atol(pPort.getValue());
  if (valid_port(port)) edited.port = (uint16_t)port;
  if (strcmp(edited.group, g_settings.group) != 0 || edited.port != g_settings.port) {
    settings_save(edited);
    g_settings = edited;
  }

  if (!ok) { g_state = NetState::Disconnected; return; }

  IPAddress group;
  group.fromString(g_settings.group);
  udp.beginMulticast(group, g_settings.port);
  g_state = NetState::Connected;
}

int net_poll(char* buf, size_t maxlen) {
  if (WiFi.status() != WL_CONNECTED) {
    g_state = NetState::Disconnected;
    return 0;
  }
  g_state = NetState::Connected;
  int len = udp.parsePacket();
  if (len <= 0) return 0;
  int n = udp.read(buf, maxlen);
  return n > 0 ? n : 0;
}

NetState net_state() {
  if (g_portal && WiFi.status() != WL_CONNECTED) return NetState::Portal;
  return g_state;
}
```

- [ ] **Step 3: Verify device compile**

Run: `pio run -e esp32dev`
Expected: `net.cpp` compiles (link still pending `main`).

- [ ] **Step 4: On-device verification (deferred to Task 9)**

Portal + multicast receive are exercised in Task 9's end-to-end checklist.

- [ ] **Step 5: Commit**

```bash
git add esp_stacklight/src/net.h esp_stacklight/src/net.cpp
git commit -m "feat(esp_stacklight): WiFiManager portal + UDP multicast receive"
```

---

### Task 9: Main wiring, status indication, end-to-end on-device verification

**Files:**
- Create: `src/main.cpp`

**Interfaces:**
- Consumes: everything — `net_*`, `parse_message`, `Lamps`, `audio_*`, `NetState`.
- Produces: `setup()` / `loop()`; a `show_status()` helper that drives the stack light per `NetState` until connected-and-idle.

- [ ] **Step 1: Implement `src/main.cpp`**

```cpp
#include <Arduino.h>
#include "config.h"
#include "protocol.h"
#include "lamps.h"
#include "audio.h"
#include "net.h"

static Lamps lamps;

// Build a status LightCommand for one color/pattern.
static LightCommand statusCmd(Color c, Pattern p, uint8_t bright, uint32_t dur, uint8_t rep) {
  LightCommand lc; lc.color = c; lc.pattern = p;
  lc.brightness = bright; lc.duration_ms = dur; lc.repeat_count = rep;
  return lc;
}

static void clear_all(uint32_t now) {
  for (int c = 0; c < 4; c++)
    lamps.apply(statusCmd((Color)c, Pattern::Solid, 0, 1, 1), now);
}

// Drive the tower to reflect connection state. Returns true while it "owns"
// the lamps (i.e. not yet connected-and-cleared), false once normal operation
// should take over.
static bool show_status(uint32_t now) {
  static NetState last = NetState::Connecting;
  static bool greeted = false;
  NetState s = net_state();

  if (s != last) {
    last = s;
    switch (s) {
      case NetState::Portal:
        clear_all(now);
        lamps.apply(statusCmd(Color::Blue, Pattern::Flash, 100, 800, 5), now);
        break;
      case NetState::Connecting:
        clear_all(now);
        lamps.apply(statusCmd(Color::Yellow, Pattern::Pulse, 100, 1000, 5), now);
        break;
      case NetState::Connected:
        clear_all(now);
        lamps.apply(statusCmd(Color::Green, Pattern::Solid, 100, 1000, 1), now);
        greeted = true;
        // schedule clear ~1s later via the static timestamp below
        break;
      case NetState::Disconnected:
        clear_all(now);
        lamps.apply(statusCmd(Color::Red, Pattern::Flash, 100, 500, 5), now);
        break;
    }
  }

  // Once connected, hold the green "ready" for ~1s, then release lamps.
  static uint32_t connectedAt = 0;
  if (s == NetState::Connected) {
    if (connectedAt == 0) connectedAt = now;
    if (now - connectedAt >= 1000) { clear_all(now); return false; }
    return true;
  } else {
    connectedAt = 0;
  }
  (void)greeted;
  return true;   // portal/connecting/disconnected keep owning the lamps
}

void setup() {
  Serial.begin(115200);
  lamps.begin();
  audio_begin();
  net_begin();           // blocks until WiFi connect or portal timeout
}

void loop() {
  uint32_t now = millis();

  bool statusOwnsLamps = show_status(now);

  char buf[600];
  int len = net_poll(buf, sizeof(buf) - 1);
  if (len > 0) {
    buf[len] = '\0';
    ParsedMessage m = parse_message(buf, len);
    if (m.kind == MsgKind::Light && !statusOwnsLamps) {
      lamps.apply(m.light, now);
    } else if (m.kind == MsgKind::Sound) {
      audio_play(m.sound);     // sound is independent of status ownership
    }
  }

  lamps.update(now);
  delay(2);                    // ~500 Hz animation tick
}
```

- [ ] **Step 2: Full device build**

Run: `pio run -e esp32dev`
Expected: links cleanly into a firmware image (no missing `setup`/`loop` now).

- [ ] **Step 3: Re-run the whole native test suite (regression)**

Run: `pio test -e native`
Expected: all suites PASS (`test_sanity`, `test_protocol`, `test_lamp_state`, `test_wav`, `test_net_validate`).

- [ ] **Step 4: Flash firmware + filesystem to a device**

Place `alert.wav`/`error.wav`/`info.wav` (16-bit mono) in `data/`, then:

Run: `pio run -e esp32dev -t upload && pio run -e esp32dev -t uploadfs`
Then: `pio device monitor`

- [ ] **Step 5: On-device verification checklist**

Confirm each, observing the tower and serial log:
- First boot with no saved WiFi → tower shows **blue flash**; `StackLight-Setup` AP appears; config page lists Multicast group + port fields.
- Enter WiFi creds (leave group/port default) → device connects → **green solid ~1s** then all off.
- From StackPI `/config → Settings → Notifications`, press **Send test (light)** for each color/pattern → matching lamp animates (flash/pulse end off; solid holds; `brightness:0` turns that color off; other colors unaffected = additive).
- Press **Send test (sound)** for `alert`/`error`/`info` → speaker plays the matching clip at the requested volume; a second sound preempts the first.
- Power-cycle → device reconnects without the portal (creds + group/port persisted).
- Pull the AP / drop WiFi → tower shows **red flash** until reconnect.

- [ ] **Step 6: Commit**

```bash
git add esp_stacklight/src/main.cpp
git commit -m "feat(esp_stacklight): main loop, status indication, end-to-end wiring"
```

---

## Self-Review

**Spec coverage:**
- Hardware/pins → Task 1 (`config.h`), Tasks 4/6 (LEDC/I2S use the pins). ✓
- Framework/build → Task 1. ✓
- Protocol parse + version gate + clamp + forward-compat → Task 2. ✓
- Lamp additive/independent, solid/flash/pulse, brightness:0=off, end-off → Tasks 3 (logic) + 4 (hardware) + 9 (additive verified on-device). ✓
- Audio WAV/LittleFS, 16-bit mono, unknown/missing ignored, volume, repeat, preempt → Tasks 5 (logic) + 6 (hardware). ✓
- Config: WiFiManager portal, group/port to NVS → Tasks 7 (validate/NVS) + 8 (portal). ✓
- Status on the stack light (blue/yellow/green/red mapping) → Task 9. ✓
- Resilience (best-effort UDP, hold last state, no error on unknown) → Tasks 2 + 8 + 9. ✓
- Testing strategy (native unit tests + on-device) → Tasks 2/3/5/7 native, Task 9 on-device. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; on-device steps give concrete commands and an explicit checklist. ✓

**Type consistency:** `LightCommand`/`SoundCommand`/`Color`/`Pattern`/`MsgKind` defined in Task 2 and consumed unchanged in Tasks 3/4/9; `Settings`/`settings_load`/`settings_save` consistent across Tasks 7/8; `NetState`/`net_begin`/`net_poll`/`net_state` consistent across Tasks 8/9; `Lamps::begin/apply/update`, `audio_begin/audio_play`, `wav_parse_header/wav_scale_sample`, `sound_file_for`, `valid_multicast_group/valid_port` all match between producer and consumer tasks. ✓

## Notes & follow-ups (out of scope for this plan)

- OTA updates, on-device WAV upload UI, and telemetry back to StackPI are intentionally excluded (YAGNI).
- The `sound_map.cpp` table is the single place to add new StackPI sound identifiers.
- If you later want exclusive (traffic-light) lamp semantics, it's a small change in `main.cpp` (clear other colors before `apply`).
