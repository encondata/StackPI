#include "audio.h"
#include "config.h"
#include "wav.h"
#include "sound_map.h"
#include <Arduino.h>
#include <LittleFS.h>
// arduino-esp32 2.x I2S: bundled I2S library (no ESP_I2S.h; that's 3.x only).
// Constructor: I2SClass(deviceIndex, clockGenerator, sdPin, sckPin, fsPin)
//   sdPin  = data out  = PIN_I2S_DIN  (25)
//   sckPin = bit clock = PIN_I2S_BCLK (27)
//   fsPin  = word sel  = PIN_I2S_LRC  (26)
#include <I2S.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>

namespace {

struct PlayReq {
  char    path[48];
  uint8_t volume;
  uint8_t repeat;
};

// I2SClass global: pins wired at construction for MAX98357A (Philips/I2S standard).
I2SClass    i2s(0, 0, PIN_I2S_DIN, PIN_I2S_BCLK, PIN_I2S_LRC);
QueueHandle_t g_queue = nullptr;   // length 1; newest request preempts
bool g_i2s_started = false;

void play_file(const PlayReq& req) {
  File f = LittleFS.open(req.path, "r");
  if (!f) { log_e("audio: missing %s", req.path); return; }

  uint8_t hdr[64];
  size_t n = f.read(hdr, sizeof(hdr));
  WavInfo w = wav_parse_header(hdr, n);
  if (!w.valid || w.bits_per_sample != 16) {
    log_e("audio: bad/unsupported WAV %s", req.path);
    f.close();
    return;
  }

  if (g_i2s_started) i2s.end();
  // I2S_PHILIPS_MODE is standard left-justified I2S, correct for MAX98357A.
  // 16-bit mono WAV; driver handles frame format internally.
  i2s.begin(I2S_PHILIPS_MODE, (int)w.sample_rate, 16);
  g_i2s_started = true;

  for (uint8_t rep = 0; rep < req.repeat; rep++) {
    f.seek(w.data_offset);
    uint32_t remaining = w.data_size;
    int16_t buf[256];
    while (remaining > 0) {
      if (uxQueueMessagesWaiting(g_queue) > 0) { f.close(); return; } // preempt
      size_t want = remaining < sizeof(buf) ? remaining : sizeof(buf);
      size_t got  = f.read((uint8_t*)buf, want);
      if (got == 0) break;
      size_t samples = got / 2;
      for (size_t i = 0; i < samples; i++) buf[i] = wav_scale_sample(buf[i], req.volume);
      i2s.write((const void*)buf, samples * 2);
      remaining -= got;
    }
  }
  f.close();
}

void audio_task(void*) {
  PlayReq req;
  for (;;) {
    if (xQueueReceive(g_queue, &req, portMAX_DELAY) == pdTRUE) {
      play_file(req);
    }
  }
}

} // namespace

void audio_begin() {
  if (!LittleFS.begin(true)) {
    log_e("audio: LittleFS mount failed");
  }
  g_queue = xQueueCreate(1, sizeof(PlayReq));
  xTaskCreatePinnedToCore(audio_task, "audio", 4096, nullptr, 1, nullptr, 0);
}

void audio_play(const SoundCommand& c) {
  const char* path = sound_file_for(c.sound);
  if (!path) { log_w("audio: unknown sound '%s'", c.sound); return; }

  PlayReq req;
  strncpy(req.path, path, sizeof(req.path) - 1);
  req.path[sizeof(req.path) - 1] = '\0';
  req.volume = c.volume;
  req.repeat = c.repeat_count;

  xQueueOverwrite(g_queue, &req);   // newest wins; playing task preempts itself
}
