#include "watchdog.h"

AlarmState watchdog_eval(uint32_t elapsed_ms, uint32_t timeout_ms, uint8_t fail_count) {
  AlarmState a{ AlarmKind::None, 0, 0 };
  if (timeout_ms == 0) return a;          // watchdog disabled

  uint32_t miss = elapsed_ms / timeout_ms;
  if (miss == 0) return a;                // still within the heartbeat window
  if (miss > 255) miss = 255;
  a.miss = (uint8_t)miss;

  if (fail_count >= 1 && miss >= fail_count) {
    a.kind = AlarmKind::Red;              // final: red on + yellow solid
    return a;
  }

  a.kind = AlarmKind::YellowFlash;
  uint32_t p = 2000;                       // miss 1 = 2s, then halve each miss
  for (uint32_t i = 1; i < miss; i++) p /= 2;
  if (p < 125) p = 125;                    // floor so it stays visible
  a.period_ms = p;
  return a;
}
