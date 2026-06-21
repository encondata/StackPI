#include "net.h"
#include "config.h"
#include "settings.h"
#include "net_validate.h"
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <WiFiManager.h>

namespace {
WiFiUDP   udp;
Settings  g_settings;
NetState  g_state = NetState::Connecting;
bool      g_portal = false;

void on_portal(WiFiManager*) {
  g_portal = true;
  Serial.printf("[net] config portal up: connect to AP \"%s\"\n", AP_NAME);
}
}

void net_begin() {
  g_settings = settings_load();

  char portStr[8];
  snprintf(portStr, sizeof(portStr), "%u", g_settings.port);

  WiFiManager wm;
  WiFiManagerParameter pGroup("group", "Multicast group", g_settings.group, 16);
  WiFiManagerParameter pPort ("port",  "Multicast port",  portStr, 8);
  wm.addParameter(&pGroup);
  wm.addParameter(&pPort);
  wm.setAPCallback(on_portal);

  g_state = NetState::Connecting;
  Serial.println("[net] connecting Wi-Fi...");

  wm.setConnectRetries(3);
  wm.setConnectTimeout(20);

  bool ok;
  if (wm.getWiFiIsSaved()) {
    // Operator/prior creds in NVS — use WiFiManager's robust connect path.
    ok = wm.autoConnect(AP_NAME);
  } else {
    // First boot: join the factory default directly in STA mode with a generous
    // timeout. WiFiManager ignores a seeded WiFi.begin ("No wifi saved,
    // skipping") and would start the power-hungry AP, so we connect ourselves
    // and stay in STA the whole time (no AP, no brownout). WiFi.persistent
    // saves the creds, so later boots take the fast saved-creds path above.
    Serial.printf("[net] no saved creds; joining default \"%s\" (up to 35s)\n", DEFAULT_WIFI_SSID);
    WiFi.persistent(true);
    WiFi.mode(WIFI_STA);
    WiFi.begin(DEFAULT_WIFI_SSID, DEFAULT_WIFI_PASS);
    unsigned long t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < 35000) {
      delay(250);
    }
    if (WiFi.status() == WL_CONNECTED) {
      ok = true;
    } else {
      Serial.println("[net] default join failed; opening config portal");
      ok = wm.autoConnect(AP_NAME);
    }
  }

  // Persist any operator edits to group/port.
  Settings edited = g_settings;
  if (valid_multicast_group(pGroup.getValue())) {
    strncpy(edited.group, pGroup.getValue(), sizeof(edited.group) - 1);
    edited.group[sizeof(edited.group) - 1] = '\0';
  }
  long port = atol(pPort.getValue());
  if (valid_port(port)) edited.port = (uint16_t)port;
  if (strcmp(edited.group, g_settings.group) != 0 || edited.port != g_settings.port) {
    settings_save(edited);
    g_settings = edited;
  }

  if (!ok) {
    Serial.println("[net] Wi-Fi connect failed (timed out)");
    g_state = NetState::Disconnected;
    return;
  }

  Serial.printf("[net] connected: ssid=%s  ip=%s  rssi=%d\n",
                WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(),
                WiFi.RSSI());

  IPAddress group;
  if (!group.fromString(g_settings.group)) {
    log_e("net: bad multicast group '%s'", g_settings.group);
    Serial.printf("[net] bad multicast group '%s'\n", g_settings.group);
    g_state = NetState::Disconnected;
    return;
  }
  udp.beginMulticast(group, g_settings.port);
  Serial.printf("[net] joined multicast %s:%u\n", g_settings.group, g_settings.port);
  g_portal = false;
  g_state = NetState::Connected;
}

int net_poll(char* buf, size_t maxlen) {
  if (WiFi.status() != WL_CONNECTED) {
    g_state = NetState::Disconnected;
    return 0;
  }
  if (g_state != NetState::Connected) {
    // (re)joined after connect or reconnect
    IPAddress group;
    if (group.fromString(g_settings.group)) {
      udp.stop();
      udp.beginMulticast(group, g_settings.port);
    }
    g_state = NetState::Connected;
  }
  int len = udp.parsePacket();
  if (len <= 0) return 0;
  int n = udp.read(buf, maxlen);
  return n > 0 ? n : 0;
}

NetState net_state() {
  if (g_portal && WiFi.status() != WL_CONNECTED) return NetState::Portal;
  return g_state;
}
