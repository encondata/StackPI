#include "wav.h"
#include <string.h>

static uint32_t rd_u32(const uint8_t* p){ return p[0] | (p[1]<<8) | (p[2]<<16) | ((uint32_t)p[3]<<24); }
static uint16_t rd_u16(const uint8_t* p){ return (uint16_t)(p[0] | (p[1]<<8)); }

WavInfo wav_parse_header(const uint8_t* buf, size_t len) {
  WavInfo w; memset(&w, 0, sizeof(w)); w.valid = false;
  if (len < 12) return w;
  if (memcmp(buf, "RIFF", 4) != 0)     return w;
  if (memcmp(buf + 8, "WAVE", 4) != 0) return w;

  size_t pos = 12;
  bool haveFmt = false, haveData = false;
  while (pos + 8 <= len) {
    const uint8_t* ck = buf + pos;
    uint32_t cksize = rd_u32(ck + 4);
    const uint8_t* body = ck + 8;
    if (memcmp(ck, "fmt ", 4) == 0 && pos + 8 + 16 <= len) {
      w.channels        = rd_u16(body + 2);
      w.sample_rate     = rd_u32(body + 4);
      w.bits_per_sample = rd_u16(body + 14);
      haveFmt = true;
    } else if (memcmp(ck, "data", 4) == 0) {
      w.data_offset = (uint32_t)(pos + 8);
      w.data_size   = cksize;
      haveData = true;
      break;
    }
    pos += 8 + cksize + (cksize & 1);   // chunks are word-aligned
  }
  w.valid = haveFmt && haveData;
  return w;
}

int16_t wav_scale_sample(int16_t s, uint8_t volume) {
  if (volume >= 100) return s;
  return (int16_t)((int32_t)s * (int32_t)volume / 100);
}
