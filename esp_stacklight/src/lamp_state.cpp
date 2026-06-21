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
