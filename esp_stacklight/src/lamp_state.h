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
