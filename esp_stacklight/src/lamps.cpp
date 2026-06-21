#include "lamps.h"
#include "config.h"
#include <Arduino.h>

static const int LAMP_PINS[4] = {
  PIN_LAMP_RED, PIN_LAMP_GREEN, PIN_LAMP_YELLOW, PIN_LAMP_BLUE
};

#if USE_RELAYS
  #if RELAY_ACTIVE_LOW
    static const int RELAY_ON  = LOW;
    static const int RELAY_OFF = HIGH;
  #else
    static const int RELAY_ON  = HIGH;
    static const int RELAY_OFF = LOW;
  #endif
#endif

void Lamps::begin() {
#if USE_RELAYS
  for (int i = 0; i < 4; i++) {
    pinMode(LAMP_PINS[i], OUTPUT);
    digitalWrite(LAMP_PINS[i], RELAY_OFF);
  }
#else
  // arduino-esp32 2.x LEDC API: channel-based (not pin-based like 3.x).
  // Channel i maps to LAMP_PINS[i].
  for (int i = 0; i < 4; i++) {
    ledcSetup(i, LEDC_FREQ_HZ, LEDC_RES_BITS);
    ledcAttachPin(LAMP_PINS[i], i);
    ledcWrite(i, 0);
  }
#endif
}

void Lamps::apply(const LightCommand& c, uint32_t now_ms) {
  state_[(int)c.color].apply(c, now_ms);
}

void Lamps::update(uint32_t now_ms) {
#if USE_RELAYS
  // Relays are on/off: any non-zero duty drives the relay on. No dimming;
  // flash still toggles, pulse collapses to on/off as it crosses zero.
  for (int i = 0; i < 4; i++) {
    digitalWrite(LAMP_PINS[i], state_[i].duty(now_ms) > 0 ? RELAY_ON : RELAY_OFF);
  }
#else
  for (int i = 0; i < 4; i++) {
    ledcWrite(i, state_[i].duty(now_ms));
  }
#endif
}
