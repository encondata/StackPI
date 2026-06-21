#pragma once
#include "protocol.h"
#include "lamp_state.h"

class Lamps {
public:
  void begin();                                      // configure LEDC on the 4 pins
  void apply(const LightCommand& c, uint32_t now_ms);// route to the color's state machine
  void update(uint32_t now_ms);                      // write all 4 duties to PWM
private:
  LampState state_[4];                               // indexed by (int)Color
};
