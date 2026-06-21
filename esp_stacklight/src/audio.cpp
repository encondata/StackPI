#include "audio.h"
#include "config.h"
#include "wav.h"
#include "sound_map.h"
#include <Arduino.h>
#include <LittleFS.h>
#include <string.h>
// Drive the MAX98357A with the stable ESP-IDF I2S driver. The Arduino 2.x
// I2S.h wrapper crashes in its DMA-complete callback (null event queue), so we
// use driver/i2s.h directly.
#include "driver/i2s.h"
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>

namespace {

struct PlayReq {
  char    path[48];
  uint8_t volume;
  uint8_t repeat;
};

const i2s_port_t I2S_PORT = I2S_NUM_0;
QueueHandle_t g_queue = nullptr;   // length 1; newest request preempts
bool g_i2s_installed = false;

static uint32_t le32(const uint8_t* p) {
  return p[0] | (p[1] << 8) | (p[2] << 16) | ((uint32_t)p[3] << 24);
}
static uint16_t le16(const uint8_t* p) { return (uint16_t)(p[0] | (p[1] << 8)); }

// Walk the RIFF chunks directly from the file, skipping any chunk that isn't
// fmt/data (e.g. Apple afconvert's "FLLR" page-alignment filler, or "fact").
static bool read_wav_info(File& f, WavInfo& w) {
  w = WavInfo{};
  uint8_t hdr[12];
  if (f.read(hdr, 12) != 12) return false;
  if (memcmp(hdr, "RIFF", 4) != 0 || memcmp(hdr + 8, "WAVE", 4) != 0) return false;

  bool haveFmt = false;
  uint8_t ch[8];
  while (f.read(ch, 8) == 8) {
    uint32_t sz = le32(ch + 4);
    if (memcmp(ch, "fmt ", 4) == 0) {
      uint8_t fmt[16];
      if (f.read(fmt, 16) != 16) return false;
      w.channels        = le16(fmt + 2);
      w.sample_rate     = le32(fmt + 4);
      w.bits_per_sample = le16(fmt + 14);
      haveFmt = true;
      uint32_t extra = (sz > 16 ? sz - 16 : 0) + (sz & 1);
      if (extra) f.seek(f.position() + extra);
    } else if (memcmp(ch, "data", 4) == 0) {
      w.data_offset = f.position();
      w.data_size   = sz;
      w.valid       = haveFmt;
      return w.valid;
    } else {
      f.seek(f.position() + sz + (sz & 1));   // skip FLLR / fact / unknown
    }
  }
  return false;
}

static void i2s_install() {
  i2s_config_t cfg = {};
  cfg.mode                 = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX);
  cfg.sample_rate          = 16000;
  cfg.bits_per_sample      = I2S_BITS_PER_SAMPLE_16BIT;
  cfg.channel_format       = I2S_CHANNEL_FMT_ONLY_LEFT;   // mono -> MAX98357A
  cfg.communication_format = I2S_COMM_FORMAT_STAND_I2S;
  cfg.intr_alloc_flags     = 0;
  cfg.dma_buf_count        = 8;
  cfg.dma_buf_len          = 256;
  cfg.use_apll             = false;
  cfg.tx_desc_auto_clear   = true;

  i2s_pin_config_t pins = {};
  pins.bck_io_num   = PIN_I2S_BCLK;
  pins.ws_io_num    = PIN_I2S_LRC;
  pins.data_out_num = PIN_I2S_DIN;
  pins.data_in_num  = I2S_PIN_NO_CHANGE;

  if (i2s_driver_install(I2S_PORT, &cfg, 0, nullptr) != ESP_OK) {
    log_e("audio: i2s_driver_install failed");
    return;
  }
  i2s_set_pin(I2S_PORT, &pins);
  g_i2s_installed = true;
}

void play_file(const PlayReq& req) {
  if (!g_i2s_installed) return;

  File f = LittleFS.open(req.path, "r");
  if (!f) { log_e("audio: missing %s", req.path); return; }

  WavInfo w;
  if (!read_wav_info(f, w) || w.bits_per_sample != 16) {
    log_e("audio: bad/unsupported WAV %s", req.path);
    f.close();
    return;
  }

  i2s_set_clk(I2S_PORT, w.sample_rate, I2S_BITS_PER_SAMPLE_16BIT, I2S_CHANNEL_MONO);

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
      size_t written = 0;
      i2s_write(I2S_PORT, buf, samples * 2, &written, portMAX_DELAY);
      remaining -= got;
    }
  }
  f.close();
  i2s_zero_dma_buffer(I2S_PORT);   // silence the DAC between clips
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
  i2s_install();
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
