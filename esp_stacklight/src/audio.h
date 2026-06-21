#pragma once
#include "protocol.h"

void audio_begin();                       // LittleFS + I2S + playback task (core 0)
void audio_play(const SoundCommand& c);   // enqueue (preempts current playback)
