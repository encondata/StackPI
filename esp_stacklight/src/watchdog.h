#pragma once
#include <stdint.h>

// Heartbeat watchdog: escalates as multicast messages go missing.
//   miss = elapsed / timeout   (one "miss" per timeout interval with no message)
//   miss 1 .. failCount-1  -> flash yellow, period halving each step (2s,1s,0.5s,…)
//   miss >= failCount      -> red on + yellow solid
// timeout_ms == 0 disables the watchdog (AlarmKind::None).

enum class AlarmKind : uint8_t { None, YellowFlash, Red };

struct AlarmState {
  AlarmKind kind;
  uint8_t   miss;       // 0 = no alarm
  uint32_t  period_ms;  // flash period for YellowFlash (full on+off cycle)
};

AlarmState watchdog_eval(uint32_t elapsed_ms, uint32_t timeout_ms, uint8_t fail_count);
