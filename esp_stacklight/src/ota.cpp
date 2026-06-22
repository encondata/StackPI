#include "ota.h"
#include "config.h"
#include <Arduino.h>
#include <ArduinoOTA.h>
#include <string.h>

void ota_begin() {
  ArduinoOTA.setHostname(OTA_HOSTNAME);
  if (strlen(OTA_PASSWORD) > 0) ArduinoOTA.setPassword(OTA_PASSWORD);

  ArduinoOTA.onStart([]() { Serial.println("[ota] update starting"); });
  ArduinoOTA.onEnd([]()   { Serial.println("[ota] update done"); });
  ArduinoOTA.onError([](ota_error_t e) { Serial.printf("[ota] error %u\n", e); });

  ArduinoOTA.begin();
  Serial.printf("[ota] ArduinoOTA ready: %s.local (pio: -t upload --upload-port %s.local)\n",
                OTA_HOSTNAME, OTA_HOSTNAME);
}

void ota_handle() { ArduinoOTA.handle(); }
