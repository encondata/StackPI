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
int16_t wav_scale_sample(int16_t sample, uint8_t volume);  // volume 0..100
