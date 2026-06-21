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
