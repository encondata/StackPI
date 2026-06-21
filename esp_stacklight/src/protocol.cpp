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
    m.sound.volume       = clamp_u8(doc["volume"] | 100, 0, 255);  // >100 = overdrive
    m.sound.duration_ms  = clamp_duration(doc["duration"] | 400);
    m.sound.repeat_count = clamp_u8(doc["repeat_count"] | 1, 1, 5);
    m.kind = MsgKind::Sound;
    return m;
  }

  return m;  // unknown type -> Ignore
}
