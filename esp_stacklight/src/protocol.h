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
