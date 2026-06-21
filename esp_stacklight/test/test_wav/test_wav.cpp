#include <unity.h>
#include <string.h>
#include "wav.h"
#include "sound_map.h"

void setUp(void) {}
void tearDown(void) {}

static void put_u32(uint8_t* p, uint32_t v){ p[0]=v; p[1]=v>>8; p[2]=v>>16; p[3]=v>>24; }
static void put_u16(uint8_t* p, uint16_t v){ p[0]=v; p[1]=v>>8; }

static size_t build_wav(uint8_t* b) {
  memcpy(b, "RIFF", 4);     put_u32(b+4, 44 - 8 + 8);
  memcpy(b+8, "WAVE", 4);
  memcpy(b+12, "fmt ", 4);  put_u32(b+16, 16);
  put_u16(b+20, 1);         // PCM
  put_u16(b+22, 1);         // mono
  put_u32(b+24, 16000);     // sample rate
  put_u32(b+28, 32000);     // byte rate
  put_u16(b+32, 2);         // block align
  put_u16(b+34, 16);        // bits per sample
  memcpy(b+36, "data", 4);  put_u32(b+40, 8);
  return 44 + 8;            // header + 8 bytes data
}

void test_wav_header_parse(void) {
  uint8_t b[64]; memset(b, 0, sizeof(b));
  size_t n = build_wav(b);
  WavInfo w = wav_parse_header(b, n);
  TEST_ASSERT_TRUE(w.valid);
  TEST_ASSERT_EQUAL_UINT16(1, w.channels);
  TEST_ASSERT_EQUAL_UINT32(16000, w.sample_rate);
  TEST_ASSERT_EQUAL_UINT16(16, w.bits_per_sample);
  TEST_ASSERT_EQUAL_UINT32(44, w.data_offset);
  TEST_ASSERT_EQUAL_UINT32(8, w.data_size);
}

void test_wav_rejects_non_riff(void) {
  uint8_t b[16]; memset(b, 0, sizeof(b));
  memcpy(b, "XXXX", 4);
  WavInfo w = wav_parse_header(b, sizeof(b));
  TEST_ASSERT_FALSE(w.valid);
}

void test_volume_scaling(void) {
  TEST_ASSERT_EQUAL_INT16(1000, wav_scale_sample(1000, 100));  // full
  TEST_ASSERT_EQUAL_INT16(500,  wav_scale_sample(1000, 50));   // half
  TEST_ASSERT_EQUAL_INT16(0,    wav_scale_sample(1000, 0));    // mute
  TEST_ASSERT_EQUAL_INT16(-250, wav_scale_sample(-1000, 25));  // negative preserved
}

void test_sound_map(void) {
  TEST_ASSERT_EQUAL_STRING("/alert.wav", sound_file_for("alert"));
  TEST_ASSERT_EQUAL_STRING("/error.wav", sound_file_for("error"));
  TEST_ASSERT_EQUAL_STRING("/info.wav",  sound_file_for("info"));
  TEST_ASSERT_NULL(sound_file_for("nope"));
  TEST_ASSERT_NULL(sound_file_for(""));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_wav_header_parse);
  RUN_TEST(test_wav_rejects_non_riff);
  RUN_TEST(test_volume_scaling);
  RUN_TEST(test_sound_map);
  return UNITY_END();
}
