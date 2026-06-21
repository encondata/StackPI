#include <Arduino.h>
#include "config.h"
#include "protocol.h"
#include "lamps.h"
#include "audio.h"
#include "net.h"

static Lamps lamps;
static bool g_statusOwns = true;       // does the status indicator currently own the lamps?
static uint32_t g_connectedAt = 0;

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

void setup() {
  Serial.begin(115200);
  lamps.begin();
  // Drive a static blue-solid indication during the blocking net_begin() phase.
  // The loop is not running yet, so we push it to the pins immediately.
  lamps.apply(statusCmd(Color::Blue, Pattern::Solid, 100, 1, 1), millis());
  lamps.update(millis());
  audio_begin();

  // Boot chime: enqueue the alert sound. The audio task runs on core 0, so it
  // plays during the blocking net_begin() below. Ignored if the WAV is missing.
  SoundCommand boot;
  strncpy(boot.sound, BOOT_SOUND_ID, sizeof(boot.sound) - 1);
  boot.sound[sizeof(boot.sound) - 1] = '\0';
  boot.volume = 100;
  boot.duration_ms = 400;
  boot.repeat_count = 1;
  audio_play(boot);

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
    if (m.kind == MsgKind::Light) {
      // A live notification supersedes the status indication.
      if (statusOwnsLamps) {
        clear_all(now);
        g_statusOwns = false;
      }
      lamps.apply(m.light, now);
    } else if (m.kind == MsgKind::Sound) {
      audio_play(m.sound);
    }
  }

  lamps.update(now);
  delay(2);
}
