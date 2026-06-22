#pragma once
#include <stdint.h>

struct Settings {
  char     group[16];     // multicast group, e.g. "239.10.10.10"
  uint16_t port;          // multicast port
  uint16_t hb_timeout_s;  // heartbeat watchdog timeout (s); 0 = disabled
  uint8_t  hb_fail_count; // misses until the red alarm
};

Settings settings_load();              // from NVS, falling back to config.h defaults
void     settings_save(const Settings& s);
