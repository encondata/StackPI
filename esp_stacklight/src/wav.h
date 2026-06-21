#pragma once
#include <stdint.h>
#include <stddef.h>

struct WavInfo {
  bool     valid;
  uint16_t channels;
  uint32_t sample_rate;
  uint16_t bits_per_sample;
  uint32_t data_offset;   // byte offset of PCM data
  uint32_t data_size;     // bytes of PCM data
};

WavInfo wav_parse_header(const uint8_t* buf, size_t len);
// volume 0..255: <100 attenuates, 100 = unity, >100 overdrives (hard-clipped).
int16_t wav_scale_sample(int16_t sample, uint8_t volume);
