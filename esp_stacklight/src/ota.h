#pragma once

// ArduinoOTA (PlatformIO / espota push over Wi-Fi). Call ota_begin() once after
// Wi-Fi connects, then ota_handle() each loop iteration. The web upload path
// (ElegantOTA at /update) is set up separately in web.cpp.
void ota_begin();
void ota_handle();
