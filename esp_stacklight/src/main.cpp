#include <Arduino.h>
#include "config.h"
#include "protocol.h"
#include "lamps.h"
#include "audio.h"
#include "net.h"
#include "notify.h"
#include "web.h"
#include "watchdog.h"
#include "ota.h"

static Lamps lamps;
static bool g_statusOwns = true;       // does the status indicator currently own the lamps?
static uint32_t g_connectedAt = 0;

// Heartbeat watchdog state.
static uint32_t g_lastMsgMs = 0;       // millis() of the last multicast message
static bool      g_gotFirstMsg = false;// watchdog stays idle until the first message
static AlarmKind g_alarmKind = AlarmKind::None;
static uint8_t   g_alarmMiss = 0;
static bool      g_yellowOn = false;   // last-applied yellow state during flash

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

// Startup color cycle: blue -> green -> yellow -> red, each on for one step,
// repeating until the total duration elapses. Blocking (runs before WiFi).
static void play_boot_animation() {
  const Color seq[4] = { Color::Blue, Color::Green, Color::Yellow, Color::Red };
  uint32_t start = millis();
  int step = 0;
  while (millis() - start < BOOT_ANIM_TOTAL_MS) {
    uint32_t now = millis();
    clear_all(now);
    lamps.apply(statusCmd(seq[step % 4], Pattern::Solid, 100, 1, 1), now);
    lamps.update(now);
    delay(BOOT_ANIM_STEP_MS);
    step++;
  }
  clear_all(millis());
  lamps.update(millis());
}

// Apply a light/sound from any source (multicast or the test web page). A live
// command supersedes the status indication.
void deliver_light(const LightCommand& c) {
  uint32_t now = millis();
  if (g_statusOwns) { clear_all(now); g_statusOwns = false; }
  lamps.apply(c, now);
  Serial.printf("[light] color=%d pattern=%d bright=%u\n",
                (int)c.color, (int)c.pattern, c.brightness);
}

void deliver_sound(const SoundCommand& c) {
  Serial.printf("[sound] %s vol=%u\n", c.sound, c.volume);
  audio_play(c);
}

// Drive the tower to reflect connection state. Returns true while it "owns"
// the lamps (i.e. not yet connected-and-cleared), false once normal operation
// should take over.
static bool show_status(uint32_t now) {
  static NetState last = NetState::Connecting;
  NetState s = net_state();

  if (s != last) {
    last = s;
    g_statusOwns = true;               // each new state re-asserts the indicator
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
        g_connectedAt = now;
        break;
      case NetState::Disconnected:
        clear_all(now);
        lamps.apply(statusCmd(Color::Red, Pattern::Flash, 100, 500, 5), now);
        break;
    }
  }

  if (!g_statusOwns) return false;

  // Release the green "ready" indication ~1s after connecting.
  if (s == NetState::Connected && now - g_connectedAt >= 1000) {
    clear_all(now);
    g_statusOwns = false;
    return false;
  }
  return true;
}

// Heartbeat watchdog: escalate when multicast messages stop arriving. Owns the
// tower (clears other colors) while alarming; cleared when a message arrives.
static void watchdog_update(uint32_t now) {
  if (net_state() != NetState::Connected) return;  // only while connected
  if (g_statusOwns) return;                         // let status indication finish first
  if (!g_gotFirstMsg) return;                       // idle until the first message proves data is flowing

  AlarmState a = watchdog_eval(now - g_lastMsgMs, net_hb_timeout_ms(), net_hb_fail_count());

  if (a.kind == AlarmKind::None) {                  // healthy
    if (g_alarmKind != AlarmKind::None) { clear_all(now); g_alarmKind = AlarmKind::None; }
    return;
  }

  if (a.kind == AlarmKind::YellowFlash) {
    if (g_alarmKind != AlarmKind::YellowFlash || g_alarmMiss != a.miss) {
      clear_all(now);                               // new level: take over the tower
      g_alarmKind = AlarmKind::YellowFlash;
      g_alarmMiss = a.miss;
      g_yellowOn  = false;
      Serial.printf("[watchdog] miss %u: yellow flash %ums\n", a.miss, a.period_ms);
    }
    bool on = (now % a.period_ms) < (a.period_ms / 2);
    if (on != g_yellowOn) {
      lamps.apply(statusCmd(Color::Yellow, Pattern::Solid, on ? 100 : 0, 1, 1), now);
      g_yellowOn = on;
    }
  } else {  // Red: red on + yellow solid
    if (g_alarmKind != AlarmKind::Red) {
      clear_all(now);
      lamps.apply(statusCmd(Color::Yellow, Pattern::Solid, 100, 1, 1), now);
      lamps.apply(statusCmd(Color::Red,    Pattern::Solid, 100, 1, 1), now);
      g_alarmKind = AlarmKind::Red;
      Serial.printf("[watchdog] miss %u: RED alarm\n", a.miss);
    }
  }
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println("[stacklight] booting");
  lamps.begin();
  play_boot_animation();   // 5s color cycle at startup
  // Drive a static blue-solid indication during the blocking net_begin() phase.
  // The loop is not running yet, so we push it to the pins immediately.
  lamps.apply(statusCmd(Color::Blue, Pattern::Solid, 100, 1, 1), millis());
  lamps.update(millis());
  audio_begin();

  net_begin();           // blocks until WiFi connect or portal timeout
  if (net_state() == NetState::Connected) {
    web_begin();         // serve the test page + /update (web OTA) once we have an IP
    ota_begin();         // ArduinoOTA (pio/espota push)
  }
  Serial.println("[stacklight] setup done, entering main loop");
  g_lastMsgMs = millis();   // start the heartbeat watchdog clock from connect

  // Boot chime — played AFTER Wi-Fi setup so the audio and Wi-Fi current
  // spikes don't overlap (which can brown out a marginal USB supply).
  // Ignored if the WAV is missing.
  SoundCommand boot;
  strncpy(boot.sound, BOOT_SOUND_ID, sizeof(boot.sound) - 1);
  boot.sound[sizeof(boot.sound) - 1] = '\0';
  boot.volume = 100;
  boot.duration_ms = 400;
  boot.repeat_count = 1;
  audio_play(boot);
}

void loop() {
  uint32_t now = millis();

  show_status(now);      // drives the status animation; deliver_light() yields it

  char buf[600];
  int len = net_poll(buf, sizeof(buf) - 1);
  if (len > 0) {
    buf[len] = '\0';
    ParsedMessage m = parse_message(buf, len);
    if (m.kind != MsgKind::Ignore) {
      g_lastMsgMs = now;          // heartbeat: reset the watchdog
      g_gotFirstMsg = true;       // first message arms the watchdog
      if (g_alarmKind != AlarmKind::None) { clear_all(now); g_alarmKind = AlarmKind::None; }
    }
    if (m.kind == MsgKind::Light) {
      deliver_light(m.light);     // logs [light] ...
    } else if (m.kind == MsgKind::Sound) {
      deliver_sound(m.sound);     // logs [sound] ...
    }
  }

  watchdog_update(now);
  web_handle();
  ota_handle();
  lamps.update(now);
  delay(2);
}
