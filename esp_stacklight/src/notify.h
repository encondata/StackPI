#pragma once
#include "protocol.h"

// Apply a light/sound command from any source (UDP multicast or the test web
// page). Defined in main.cpp; routes through the same status-ownership +
// hardware path so all triggers behave identically.
void deliver_light(const LightCommand& c);
void deliver_sound(const SoundCommand& c);
