#pragma once
#include <stdint.h>

struct Settings {
  char     group[16];   // multicast group, e.g. "239.10.10.10"
  uint16_t port;        // multicast port
};

Settings settings_load();              // from NVS, falling back to config.h defaults
void     settings_save(const Settings& s);
